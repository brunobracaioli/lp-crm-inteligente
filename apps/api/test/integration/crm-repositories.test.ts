import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import type { LeadActivityRecord } from '#/modules/crm/application/ports.ts';
import {
  InvalidIcpSettingsError,
  createPostgresIcpSettingsProvider,
} from '#/modules/crm/infrastructure/postgres-icp-settings-provider.ts';
import { createPostgresLeadActivityRepository } from '#/modules/crm/infrastructure/postgres-lead-activity-repository.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import { FixtureScope, aLeadState } from './support/fixtures.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

const LOCK_NOT_AVAILABLE = '55P03';
const RACE_ROUNDS = 5;

const ids = new RandomUuidV7Generator();
const leads = createPostgresLeadRepository();
const activities = createPostgresLeadActivityRepository();
const icp = createPostgresIcpSettingsProvider();

let db: TestDatabase;
let scope: FixtureScope;
let uow: UnitOfWork;

beforeAll(async () => {
  db = await openTestDatabase();
  uow = createPostgresUnitOfWork(db.app);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  scope = new FixtureScope(db.admin, ids);
});

afterEach(async () => {
  await scope.dispose();
});

describe('PostgresLeadRepository', () => {
  it('round-trips every column of the aggregate', async () => {
    const { workspaceId } = await scope.workspace();
    const lead = aLeadState(workspaceId, ids);

    const inserted = await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, lead));
    const found = await uow.run(workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, workspaceId, lead.email),
    );

    expect(inserted).toBe('inserted');
    expect(found).toEqual(lead);
  });

  it('round-trips a lead with optional fields empty and a lost stage', async () => {
    const { workspaceId } = await scope.workspace();
    const lead = aLeadState(workspaceId, ids, {
      areaOfExpertise: 'other',
      areaOfExpertiseOther: 'Gestão de frotas',
      jobTitle: null,
      companySize: null,
      companyWebsite: null,
      stage: 'lost',
      lostReason: 'no_budget',
      scoreBreakdown: [],
      firstTouch: {
        ...aLeadState(workspaceId, ids).firstTouch,
        utmSource: null,
        fbclid: null,
        landingPageUrl: null,
      },
    });

    await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, lead));
    const found = await uow.run(workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, workspaceId, lead.email),
    );

    expect(found).toEqual(lead);
  });

  it('insertIfAbsent reports exists for the same active e-mail and keeps the first row', async () => {
    const { workspaceId } = await scope.workspace();
    const first = aLeadState(workspaceId, ids);
    const second = aLeadState(workspaceId, ids, { email: first.email, firstName: 'Outra' });

    const outcomes = [
      await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, first)),
      await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, second)),
    ];
    const stored = await uow.run(workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, workspaceId, first.email),
    );

    expect(outcomes).toEqual(['inserted', 'exists']);
    expect(stored?.id).toBe(first.id);
    expect(stored?.firstName).toBe('Maria');
  });

  it('insertIfAbsent accepts the e-mail again after the lead was anonymized', async () => {
    const { workspaceId } = await scope.workspace();
    const anonymized = aLeadState(workspaceId, ids, {
      anonymizedAt: new Date('2026-11-03T13:00:00.000Z'),
    });
    const returning = aLeadState(workspaceId, ids, { email: anonymized.email });

    await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, anonymized));
    const outcome = await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, returning));
    const active = await uow.run(workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, workspaceId, anonymized.email),
    );

    expect(outcome).toBe('inserted');
    expect(active?.id).toBe(returning.id);
  });

  it('race: two concurrent transactions inserting the same e-mail yield one inserted and one exists', async () => {
    const { workspaceId } = await scope.workspace();

    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const email = `race-${String(round)}-${workspaceId.slice(-8)}@empresa.com.br`;
      const outcomes = await Promise.all([
        uow.run(workspaceId, (tx) =>
          leads.insertIfAbsent(tx, aLeadState(workspaceId, ids, { email })),
        ),
        uow.run(workspaceId, (tx) =>
          leads.insertIfAbsent(tx, aLeadState(workspaceId, ids, { email })),
        ),
      ]);

      expect([...outcomes].sort()).toEqual(['exists', 'inserted']);
    }
    const stored = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.leads WHERE workspace_id = ${workspaceId}
    `;
    expect(stored[0]?.n).toBe(RACE_ROUNDS);
  });

  it('findActiveByEmailForUpdate holds a row lock until the transaction ends', async () => {
    const { workspaceId } = await scope.workspace();
    const lead = aLeadState(workspaceId, ids);
    await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, lead));

    const contender = await uow.run(workspaceId, async (holder) => {
      await leads.findActiveByEmailForUpdate(holder, workspaceId, lead.email);
      // A second transaction fails fast on the held lock instead of waiting for it.
      return uow
        .run(workspaceId, async (tx) => {
          await unwrapTransaction(tx)`SELECT pg_catalog.set_config('lock_timeout', '200', true)`;
          return leads.findActiveByEmailForUpdate(tx, workspaceId, lead.email);
        })
        .catch((error: unknown) => error);
    });
    const afterRelease = await uow.run(workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, workspaceId, lead.email),
    );

    expect(contender).toMatchObject({ code: LOCK_NOT_AVAILABLE });
    expect(afterRelease?.id).toBe(lead.id);
  });

  it('update is optimistic: it bumps the version and refuses a stale expected version', async () => {
    const { workspaceId } = await scope.workspace();
    const lead = aLeadState(workspaceId, ids);
    await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, lead));

    const changed = {
      ...lead,
      stage: 'contacted' as const,
      score: 80,
      scoreBand: 'A' as const,
      scoreBreakdown: [{ ruleId: 'fit_segment', points: 80 }],
      submissionsCount: 2,
      lastTouch: { ...lead.lastTouch, utmSource: 'google', fbclid: null },
    };
    const first = await uow.run(workspaceId, (tx) => leads.update(tx, changed, 1));
    const stale = await uow.run(workspaceId, (tx) => leads.update(tx, { ...changed, score: 5 }, 1));
    const stored = await uow.run(workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, workspaceId, lead.email),
    );

    expect(first).toBe('updated');
    expect(stale).toBe('version_conflict');
    expect(stored).toMatchObject({
      stage: 'contacted',
      score: 80,
      scoreBand: 'A',
      submissionsCount: 2,
      version: 2,
      scoreBreakdown: [{ ruleId: 'fit_segment', points: 80 }],
      lastTouch: { utmSource: 'google', fbclid: null },
      firstTouch: lead.firstTouch,
    });
    // updated_at is owned by the trigger, not by the caller.
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(lead.updatedAt.getTime());
  });
});

describe('PostgresLeadActivityRepository', () => {
  it('appends timeline rows with their JSON data', async () => {
    const { workspaceId } = await scope.workspace();
    const lead = aLeadState(workspaceId, ids);
    await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, lead));
    const activity: LeadActivityRecord = {
      id: ids.uuidv7(),
      workspaceId,
      leadId: lead.id,
      type: 'submission_received',
      actorType: 'system',
      actorId: null,
      data: { submission_id: ids.uuidv7(), is_new: true, attempt: 1, note: null },
      createdAt: new Date('2026-11-03T12:00:00.000Z'),
    };

    await uow.run(workspaceId, (tx) => activities.append(tx, activity));

    const rows = await db.admin<
      {
        id: string;
        type: string;
        actor_type: string;
        actor_id: string | null;
        data: unknown;
        created_at: Date;
      }[]
    >`
      SELECT id, type, actor_type, actor_id, data, created_at
      FROM crm.lead_activities WHERE lead_id = ${lead.id}
    `;
    expect(rows).toEqual([
      {
        id: activity.id,
        type: 'submission_received',
        actor_type: 'system',
        actor_id: null,
        data: activity.data,
        created_at: activity.createdAt,
      },
    ]);
  });

  it('rejects an activity pointing at a lead of another workspace (tenant-safe foreign key)', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const leadOfB = aLeadState(b.workspaceId, ids);
    await uow.run(b.workspaceId, (tx) => leads.insertIfAbsent(tx, leadOfB));

    await expect(
      uow.run(a.workspaceId, (tx) =>
        activities.append(tx, {
          id: ids.uuidv7(),
          workspaceId: a.workspaceId,
          leadId: leadOfB.id,
          type: 'note_added',
          actorType: 'system',
          actorId: null,
          data: {},
          createdAt: new Date('2026-11-03T12:00:00.000Z'),
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('PostgresIcpSettingsProvider', () => {
  it('returns null when the workspace has no ICP', async () => {
    const { workspaceId } = await scope.workspace();

    expect(await uow.run(workspaceId, (tx) => icp.getIcp(tx, workspaceId))).toBeNull();
  });

  it('maps settings.icp to IcpSettings', async () => {
    const { workspaceId } = await scope.workspace({
      icp: {
        priority_areas: ['technology', 'finance'],
        secondary_areas: ['health'],
        senior_title_patterns: ['ceo', 'diretor'],
      },
    });

    expect(await uow.run(workspaceId, (tx) => icp.getIcp(tx, workspaceId))).toEqual({
      priorityAreas: ['technology', 'finance'],
      secondaryAreas: ['health'],
      seniorTitlePatterns: ['ceo', 'diretor'],
    });
  });

  it('fails loudly on an ICP that does not match the schema', async () => {
    const { workspaceId } = await scope.workspace({
      icp: { priority_areas: ['not_an_area'], secondary_areas: [], senior_title_patterns: [] },
    });

    await expect(uow.run(workspaceId, (tx) => icp.getIcp(tx, workspaceId))).rejects.toThrow(
      InvalidIcpSettingsError,
    );
  });

  it('does not expose the ICP of another workspace', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace({
      icp: { priority_areas: ['technology'], secondary_areas: [], senior_title_patterns: [] },
    });

    expect(await uow.run(a.workspaceId, (tx) => icp.getIcp(tx, b.workspaceId))).toBeNull();
  });
});
