import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKeyedMac } from '#/platform/crypto/derived-key.ts';
import { createPostgresAuditLogWriter } from '#/platform/db/postgres-audit-log-writer.ts';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import type { AuditLogWriter } from '#/shared/audit.ts';
import type { CorrelationId, LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import { createAddLeadNote } from '#/modules/crm/application/commands/add-lead-note.ts';
import { createAnonymizeLead } from '#/modules/crm/application/commands/anonymize-lead.ts';
import { createAssignLeadOwner } from '#/modules/crm/application/commands/assign-lead-owner.ts';
import { createChangeLeadStage } from '#/modules/crm/application/commands/change-lead-stage.ts';
import { createExportLeadData } from '#/modules/crm/application/commands/export-lead-data.ts';
import {
  createExportLeadsCsv,
  EXPORT_MAX_ROWS,
} from '#/modules/crm/application/commands/export-leads-csv.ts';
import type { RawBody } from '#/modules/crm/application/commands/failures.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import { createRecordDenial } from '#/modules/crm/application/commands/record-denial.ts';
import { createPostgresAnonymizationGateway } from '#/modules/crm/infrastructure/postgres-anonymization-gateway.ts';
import { createPostgresLeadActivityRepository } from '#/modules/crm/infrastructure/postgres-lead-activity-repository.ts';
import { createPostgresLeadExportReader } from '#/modules/crm/infrastructure/postgres-lead-export-reader.ts';
import { createPostgresLeadNoteReader } from '#/modules/crm/infrastructure/postgres-lead-note-reader.ts';
import { createPostgresLeadReader } from '#/modules/crm/infrastructure/postgres-lead-reader.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import { createPostgresMemberDirectory } from '#/modules/crm/infrastructure/postgres-member-directory.ts';
import {
  createPostgresStageChangeOutbox,
  stageEventId,
} from '#/modules/crm/infrastructure/postgres-stage-change-outbox.ts';
import { createPostgresSubjectDataReader } from '#/modules/crm/infrastructure/postgres-subject-data-reader.ts';
import { leadDataExportView } from '#/modules/crm/presentation/data-export-view.ts';
import { FakeClock } from '#test/fakes/clock.ts';
import {
  FakeExportLock,
  FakeStaffIdempotencyStore,
  KEY_1,
  KEY_2,
} from '#test/fakes/crm-commands.ts';
import { createContract } from '#test/contract/openapi.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import { FixtureScope, aLeadState, type WorkspaceFixture } from './support/fixtures.ts';
import { createSubmitLeadIntegration } from './support/harness.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

/**
 * Staff commands against real Postgres as `lp_api` (RLS in force). Prerequisites that other waves
 * deliver as migrations — `core.workspace_members` (staff auth) and `crm.anonymize_lead` (6b) — are
 * detected; the tests that need them run once the local database has them.
 */

const ids = new RandomUuidV7Generator();
const json = (value: unknown): RawBody => ({ kind: 'json', value });
const CORRELATION = '00000000-0000-4000-8000-00000000c0de' as CorrelationId;
const PEPPER = Buffer.alloc(32, 5).toString('base64');
const BULK_LEADS = EXPORT_MAX_ROWS + 3;

// Opened at module level so the `skipIf` guards below know the schema when the tests are registered.
const db: TestDatabase = await openTestDatabase();
const probe = await db.admin<{ members: string | null; fn: string | null }[]>`
  SELECT
    to_regclass('core.workspace_members')::text AS members,
    to_regprocedure('crm.anonymize_lead(uuid,text,uuid,uuid)')::text AS fn
`;
// Skipped only while the local database lacks the migration of another wave (auth: workspace_members;
// 6b: anonymize_lead). With those applied (or the local stubs) nothing is skipped.
const hasMembers = probe[0]?.members != null;
const hasAnonymizeFunction = probe[0]?.fn != null;

let scope: FixtureScope;
let fixture: WorkspaceFixture;
let other: WorkspaceFixture;

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  scope = new FixtureScope(db.admin, ids);
  fixture = await scope.workspace();
  other = await scope.workspace();
});

afterEach(async () => {
  if (hasMembers) {
    for (const { workspaceId } of [fixture, other]) {
      await db.admin`DELETE FROM core.workspace_members WHERE workspace_id = ${workspaceId}`;
    }
  }
  await scope.dispose();
});

function actorOf(
  role: StaffActor['role'],
  workspaceId: WorkspaceId = fixture.workspaceId,
): StaffActor {
  return { userId: ids.uuidv7() as UserId, workspaceId, role };
}

async function addMember(workspaceId: WorkspaceId, userId: UserId, active = true): Promise<void> {
  await db.admin`
    INSERT INTO core.workspace_members (workspace_id, user_id, role, display_name, active)
    VALUES (${workspaceId}, ${userId}, 'sales', 'Vendedor', ${active})
  `;
}

/** Every command use case over the real adapters; Redis ports are the in-memory fakes. */
function createCommands(overrides: { audit?: AuditLogWriter } = {}) {
  const uow = createPostgresUnitOfWork(db.app);
  const leads = createPostgresLeadRepository();
  const reader = createPostgresLeadReader();
  const activities = createPostgresLeadActivityRepository();
  const audit = overrides.audit ?? createPostgresAuditLogWriter();
  const idempotency = new FakeStaffIdempotencyStore();
  const clock = new FakeClock();
  const lock = new FakeExportLock();
  const gateway = createPostgresAnonymizationGateway();
  const mutation = {
    unitOfWork: uow,
    leads: reader,
    leadWriter: leads,
    activities,
    audit,
    idempotency,
    clock,
    ids,
  };
  return {
    uow,
    leads,
    reader,
    idempotency,
    clock,
    lock,
    audit,
    changeLeadStage: createChangeLeadStage({
      ...mutation,
      stageOutbox: createPostgresStageChangeOutbox(),
    }),
    assignLeadOwner: createAssignLeadOwner({
      ...mutation,
      members: createPostgresMemberDirectory(),
    }),
    addLeadNote: createAddLeadNote({ ...mutation, notes: createPostgresLeadNoteReader() }),
    exportLeadsCsv: createExportLeadsCsv({
      unitOfWork: uow,
      reader: createPostgresLeadExportReader(),
      lock,
      audit,
      clock,
      ids,
    }),
    exportLeadData: createExportLeadData({
      unitOfWork: uow,
      leads: reader,
      subjectData: createPostgresSubjectDataReader(),
      audit,
      clock,
    }),
    anonymizeLead: createAnonymizeLead({
      unitOfWork: uow,
      leads: reader,
      gateway,
      audit,
      idempotency,
      planMac: createKeyedMac(PEPPER, 'crm-plan-v1'),
      clock,
    }),
    recordDenial: createRecordDenial({ unitOfWork: uow, audit, clock }),
  };
}

async function seedLead(
  workspaceId: WorkspaceId,
  overrides: Parameters<typeof aLeadState>[2] = {},
): Promise<LeadId> {
  const uow = createPostgresUnitOfWork(db.app);
  const lead = aLeadState(workspaceId, ids, { version: 1, ...overrides });
  await uow.run(workspaceId, (tx) => createPostgresLeadRepository().insertIfAbsent(tx, lead));
  return lead.id;
}

async function leadRow(leadId: LeadId) {
  const rows = await db.admin<
    { stage: string; version: number; owner_user_id: string | null; anonymized_at: Date | null }[]
  >`
    SELECT stage, version, owner_user_id, anonymized_at FROM crm.leads WHERE id = ${leadId}
  `;
  return rows[0];
}

async function auditRows(workspaceId: WorkspaceId) {
  return db.admin<
    {
      action: string;
      result: string;
      actor_id: string | null;
      resource_id: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`
    SELECT action, result, actor_id, resource_id, metadata FROM core.audit_log
    WHERE workspace_id = ${workspaceId} ORDER BY id
  `;
}

async function activityTypes(leadId: LeadId): Promise<string[]> {
  const rows = await db.admin<{ type: string }[]>`
    SELECT type FROM crm.lead_activities WHERE lead_id = ${leadId} ORDER BY created_at, id
  `;
  return rows.map((row) => row.type);
}

async function tableCounts(workspaceId: WorkspaceId) {
  const rows = await db.admin<
    { leads: number; activities: number; submissions: number; consents: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM crm.leads WHERE workspace_id = ${workspaceId}) AS leads,
      (SELECT count(*)::int FROM crm.lead_activities WHERE workspace_id = ${workspaceId}) AS activities,
      (SELECT count(*)::int FROM capture.submissions WHERE workspace_id = ${workspaceId}) AS submissions,
      (SELECT count(*)::int FROM capture.consents WHERE workspace_id = ${workspaceId}) AS consents
  `;
  return rows[0];
}

const stageBody = (expectedVersion: number, to = 'contacted') =>
  json({ to_stage: to, expected_version: expectedVersion });

describe('changeLeadStage through Postgres', () => {
  it('moves the lead, bumps the version and writes the timeline and audit in one commit', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);
    const actor = actorOf('admin');

    const result = await c.changeLeadStage({
      actor,
      leadId,
      body: stageBody(1),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });

    expect(result).toMatchObject({ ok: true, value: { stage: 'contacted', version: 2 } });
    expect(await leadRow(leadId)).toMatchObject({ stage: 'contacted', version: 2 });
    expect(await activityTypes(leadId)).toEqual(['stage_changed']);
    expect(await auditRows(fixture.workspaceId)).toEqual([
      expect.objectContaining({
        action: 'lead.stage_changed',
        result: 'success',
        actor_id: actor.userId,
        resource_id: leadId,
      }),
    ]);
  });

  it('AC-CRM-08: a stale expected_version is 409 and the database is byte-identical', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId, { version: 5 });
    const before = await tableCounts(fixture.workspaceId);

    const result = await c.changeLeadStage({
      actor: actorOf('admin'),
      leadId,
      body: stageBody(4),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'version_conflict' } });
    expect(await leadRow(leadId)).toMatchObject({ stage: 'new', version: 5 });
    expect(await tableCounts(fixture.workspaceId)).toEqual(before);
    expect(await auditRows(fixture.workspaceId)).toHaveLength(0);
  });

  it('ST-22: two parallel requests with the same version — exactly one wins', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);
    const request = (to: string) =>
      c.changeLeadStage({
        actor: actorOf('admin'),
        leadId,
        body: stageBody(1, to),
        idempotencyKey: null,
        correlationId: CORRELATION,
      });

    const outcomes = await Promise.all([request('contacted'), request('qualified')]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      { ok: false, error: { code: 'version_conflict' } },
    ]);
    expect((await leadRow(leadId))?.version).toBe(2);
    expect(await activityTypes(leadId)).toHaveLength(1);
    expect(
      (await auditRows(fixture.workspaceId)).filter((r) => r.result === 'success'),
    ).toHaveLength(1);
  });

  it('G6: sales moving an unowned lead becomes its owner with a single version bump', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);
    const sales = actorOf('sales');

    const result = await c.changeLeadStage({
      actor: sales,
      leadId,
      body: stageBody(1),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });

    expect(result.ok).toBe(true);
    expect(await leadRow(leadId)).toMatchObject({
      stage: 'contacted',
      version: 2,
      owner_user_id: sales.userId,
    });
    expect(await activityTypes(leadId)).toEqual(['owner_assigned', 'stage_changed']);
  });

  it("records a refusal (sales on another user's lead) as a committed denied audit row", async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId, { ownerUserId: ids.uuidv7() as UserId });
    const sales = actorOf('sales');

    const result = await c.changeLeadStage({
      actor: sales,
      leadId,
      body: stageBody(1),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(await leadRow(leadId)).toMatchObject({ stage: 'new', version: 1 });
    expect(await auditRows(fixture.workspaceId)).toEqual([
      expect.objectContaining({
        result: 'denied',
        actor_id: sales.userId,
        metadata: { reason: 'not_owner' },
      }),
    ]);
  });

  it('AC-CRM-06 / ST-15: a lead of another workspace is 404 and RLS hides it even from a raw read', async () => {
    const c = createCommands();
    const foreignId = await seedLead(other.workspaceId);

    const result = await c.changeLeadStage({
      actor: actorOf('admin'),
      leadId: foreignId,
      body: stageBody(1),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });
    // the filter of the repository removed: only RLS stands between workspace A and the row
    const raw = await c.uow.run(fixture.workspaceId, async (tx) => {
      const { unwrapTransaction } = await import('#/platform/db/transaction.ts');
      return unwrapTransaction(tx)<object[]>`SELECT id FROM crm.leads WHERE id = ${foreignId}`;
    });

    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(raw).toHaveLength(0);
    expect(await leadRow(foreignId)).toMatchObject({ stage: 'new', version: 1 });
  });

  it('C28: if the audit row cannot be written the mutation is rolled back (500, not a silent change)', async () => {
    const failing: AuditLogWriter = { append: () => Promise.reject(new Error('audit store down')) };
    const c = createCommands({ audit: failing });
    const leadId = await seedLead(fixture.workspaceId);

    await expect(
      c.changeLeadStage({
        actor: actorOf('admin'),
        leadId,
        body: stageBody(1),
        idempotencyKey: null,
        correlationId: CORRELATION,
      }),
    ).rejects.toThrow('audit store down');

    expect(await leadRow(leadId)).toMatchObject({ stage: 'new', version: 1 });
    expect(await activityTypes(leadId)).toHaveLength(0);
  });

  it('enqueues one deterministic lead.stage_changed outbox event per lead and stage', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);
    const admin = actorOf('admin');
    const send = (version: number, to: string, extra: Record<string, unknown> = {}) =>
      c.changeLeadStage({
        actor: admin,
        leadId,
        body: json({ to_stage: to, expected_version: version, ...extra }),
        idempotencyKey: null,
        correlationId: CORRELATION,
      });

    await send(1, 'qualified');
    await send(2, 'lost', { lost_reason: 'timing' });
    await send(3, 'contacted');
    await send(4, 'qualified');

    const events = await db.admin<
      { id: string; event_type: string; payload: Record<string, string> }[]
    >`
      SELECT id, event_type, payload FROM tracking.outbox_events WHERE workspace_id = ${fixture.workspaceId}
    `;
    expect(events).toEqual([
      {
        id: stageEventId(leadId, 'qualified'),
        event_type: 'lead.stage_changed',
        payload: { lead_id: leadId, to_stage: 'qualified' },
      },
    ]);
  });
});

describe('assignLeadOwner through Postgres', () => {
  it.skipIf(!hasMembers)(
    'assigns an active member and rejects inactive, foreign and unknown targets',
    async () => {
      const c = createCommands();
      const leadId = await seedLead(fixture.workspaceId);
      const active = ids.uuidv7() as UserId;
      const inactive = ids.uuidv7() as UserId;
      const foreign = ids.uuidv7() as UserId;
      await addMember(fixture.workspaceId, active);
      await addMember(fixture.workspaceId, inactive, false);
      await addMember(other.workspaceId, foreign);
      const admin = actorOf('admin');
      const assign = (owner: string | null, version: number) =>
        c.assignLeadOwner({
          actor: admin,
          leadId,
          body: json({ owner_user_id: owner, expected_version: version }),
          idempotencyKey: null,
          correlationId: CORRELATION,
        });

      const bad = await Promise.all([
        assign(inactive, 1),
        assign(foreign, 1),
        assign(ids.uuidv7(), 1),
      ]);
      const good = await assign(active, 1);

      for (const result of bad) {
        expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
      }
      expect(good).toMatchObject({ ok: true, value: { ownerUserId: active, version: 2 } });
      expect(await activityTypes(leadId)).toEqual(['owner_assigned']);
    },
  );
});

describe('addLeadNote through Postgres', () => {
  it('stores a note at the largest size the activity CHECK allows and reads it back', async () => {
    // 2666 × 3 bytes = 7998 bytes: the biggest CJK note under the 8000-byte cap (data CHECK: 8192)
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);
    const text = '日'.repeat(2666);

    const result = await c.addLeadNote({
      actor: actorOf('admin'),
      leadId,
      body: json({ body: text }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });

    expect(result).toMatchObject({ ok: true, value: { body: text } });
    const stored = await db.admin<{ data: { body: string } }[]>`
      SELECT data FROM crm.lead_activities WHERE lead_id = ${leadId} AND type = 'note_added'
    `;
    expect(stored[0]?.data.body).toBe(text);
  });

  it('stores 5000 ASCII characters (the contract maximum) and refuses what the CHECK could not hold', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);
    const note = (text: string, key: typeof KEY_1) =>
      c.addLeadNote({
        actor: actorOf('admin'),
        leadId,
        body: json({ body: text }),
        idempotencyKey: key,
        correlationId: CORRELATION,
      });

    const ascii = await note('a'.repeat(5000), KEY_1);
    // 4000 CJK characters are within 5000 code points but 12 000 bytes: refused up front (400), never a 500
    const wide = await note('日'.repeat(4000), KEY_2);

    expect(ascii.ok).toBe(true);
    expect(wide).toEqual({
      ok: false,
      error: { code: 'validation_failed', errors: [{ field: 'body', code: 'too_long' }] },
    });
    expect(await activityTypes(leadId)).toEqual(['note_added']);
  });

  it('writes the note once per Idempotency-Key and leaves version and owner untouched', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);
    const admin = actorOf('admin');
    const first = await c.addLeadNote({
      actor: admin,
      leadId,
      body: json({ body: 'Ligar' }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });
    const replay = await c.addLeadNote({
      actor: admin,
      leadId,
      body: json({ body: 'Ligar' }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });

    expect(first.ok && replay.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(await activityTypes(leadId)).toEqual(['note_added']);
    expect(await leadRow(leadId)).toMatchObject({ version: 1, owner_user_id: null });
  });

  it('ST-30: audit rows never contain the note text or any lead PII', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId);

    await c.addLeadNote({
      actor: actorOf('admin'),
      leadId,
      body: json({ body: 'proposta confidencial' }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });
    await c.changeLeadStage({
      actor: actorOf('admin'),
      leadId,
      body: stageBody(1),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });

    const serialized = JSON.stringify(await auditRows(fixture.workspaceId));
    expect(serialized).not.toMatch(/proposta|maria|silva|empresa|@|\+55/i);
  });

  it('answers 409 for a note on an anonymized lead', async () => {
    const c = createCommands();
    const leadId = await seedLead(fixture.workspaceId, {
      anonymizedAt: new Date('2026-11-04T00:00:00Z'),
    });

    const result = await c.addLeadNote({
      actor: actorOf('admin'),
      leadId,
      body: json({ body: 'x' }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
  });
});

describe('recordDenial through Postgres', () => {
  it('commits a denied audit row in its own transaction, with no PII', async () => {
    const c = createCommands();
    const actor = actorOf('viewer');

    const recorded = await c.recordDenial({
      actor,
      action: 'lead.exported',
      resourceType: 'lead_export',
      resourceId: null,
      reason: 'forbidden',
      correlationId: CORRELATION,
    });

    expect(recorded).toBe(true);
    expect(await auditRows(fixture.workspaceId)).toEqual([
      expect.objectContaining({
        action: 'lead.exported',
        result: 'denied',
        actor_id: actor.userId,
        resource_id: '00000000-0000-0000-0000-000000000000',
        metadata: { reason: 'forbidden' },
      }),
    ]);
  });
});

describe('exportLeadsCsv through Postgres (as lp_api)', () => {
  it("AC-CRM-07: exports =1+1 as '=1+1, only the credential's workspace, newest first, and audits it", async () => {
    const c = createCommands();
    const older = await seedLead(fixture.workspaceId, {
      firstName: '=1+1',
      createdAt: new Date('2026-11-01T10:00:00Z'),
    });
    const newer = await seedLead(fixture.workspaceId, {
      firstName: 'Carla',
      createdAt: new Date('2026-11-02T10:00:00Z'),
    });
    await seedLead(other.workspaceId, { firstName: 'Estranho' });
    const admin = actorOf('admin');

    const result = await c.exportLeadsCsv({
      actor: admin,
      query: new Map(),
      correlationId: CORRELATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.csv.replace('﻿', '').trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(newer);
    expect(lines[2]).toContain(older);
    expect(lines[2]).toContain(",'=1+1,");
    expect(result.value.csv).not.toContain('Estranho');
    expect(result.value.csv).not.toMatch(/IwAR123|203\.0\.113/);
    expect(await auditRows(fixture.workspaceId)).toEqual([
      expect.objectContaining({
        action: 'lead.exported',
        result: 'success',
        actor_id: admin.userId,
        metadata: { row_count: 2, truncated: false, filters: '' },
      }),
    ]);
    expect(c.lock.held.size).toBe(0);
  });

  it('filters by stage, band and owner with bound parameters', async () => {
    const c = createCommands();
    const admin = actorOf('admin');
    await seedLead(fixture.workspaceId, {
      stage: 'qualified',
      scoreBand: 'A',
      ownerUserId: admin.userId,
    });
    await seedLead(fixture.workspaceId, { stage: 'qualified', scoreBand: 'A' });
    await seedLead(fixture.workspaceId, {
      stage: 'new',
      scoreBand: 'A',
      ownerUserId: admin.userId,
    });
    const run = (entries: Record<string, string[]>) =>
      c.exportLeadsCsv({
        actor: admin,
        query: new Map(Object.entries(entries)),
        correlationId: CORRELATION,
      });

    const mine = await run({ stage: ['qualified'], owner: ['me'], score_band: ['A'] });
    const unassigned = await run({ owner: ['unassigned'] });
    const injected = await run({ stage: ["new' OR '1'='1"] });

    expect(mine.ok && mine.value.rowCount).toBe(1);
    expect(unassigned.ok && unassigned.value.rowCount).toBe(1);
    expect(injected).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });

  it('ST-20: caps at 10 000 rows and flags the truncation', async () => {
    const c = createCommands();
    await db.admin`
      INSERT INTO crm.leads (
        id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name,
        area_of_expertise, first_submitted_at, last_submitted_at, created_at
      )
      SELECT gen_random_uuid(), ${fixture.workspaceId}, 'Bulk', 'Lead', 'bulk' || g || '@example.com',
             '+5511999990000', 'Bulk Ltda', 'technology', now(), now(), now() - (g || ' seconds')::interval
      FROM generate_series(1, ${BULK_LEADS}) AS g
    `;

    const result = await c.exportLeadsCsv({
      actor: actorOf('admin'),
      query: new Map(),
      correlationId: CORRELATION,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { rowCount: EXPORT_MAX_ROWS, truncated: true },
    });
    expect((await auditRows(fixture.workspaceId))[0]?.metadata).toMatchObject({
      row_count: EXPORT_MAX_ROWS,
      truncated: true,
    });
  }, 60_000);
});

async function submitRealLead(workspace: WorkspaceFixture, email = 'carla@acme.com.br') {
  const submit = createSubmitLeadIntegration(db.app, workspace);
  const result = await submit.submit({ email, first_name: 'Carla', last_name: 'Menezes' });
  if (!result.ok) throw new Error('submission refused');
  const rows = await db.admin<{ lead_id: string }[]>`
    SELECT lead_id FROM capture.submissions WHERE id = ${result.value.accepted.submissionId}
  `;
  return { leadId: rows[0]?.lead_id as LeadId, submit };
}

describe('exportLeadData through Postgres', () => {
  it('ST-27: delivers a body that conforms to the LeadDataExport schema, with IP/UA still held', async () => {
    const c = createCommands();
    const { leadId } = await submitRealLead(fixture);
    await c.addLeadNote({
      actor: actorOf('admin'),
      leadId,
      body: json({ body: 'nota' }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });
    await c.changeLeadStage({
      actor: actorOf('admin'),
      leadId,
      body: stageBody(1),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });
    await c.exportLeadsCsv({
      actor: actorOf('admin'),
      query: new Map(),
      correlationId: CORRELATION,
    });
    const admin = actorOf('admin');

    const result = await c.exportLeadData({ actor: admin, leadId, correlationId: CORRELATION });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = leadDataExportView(result.value);
    const problems = createContract().responseProblems('/v1/crm/leads/{id}/data-export', 'get', {
      status: 200,
      headers: new Headers({
        'Content-Type': 'application/json',
        'X-Request-Id': CORRELATION,
        'Content-Disposition': `attachment; filename="lead-data-export-${leadId}.json"`,
      }),
      bodyText: JSON.stringify(view),
    });
    expect(problems).toEqual([]);
    expect(view).toMatchObject({
      truncated: false,
      lead: { id: leadId },
      submissions: [{ client_ip: '203.0.113.7', message: null }],
    });
    expect((view.consents as unknown[]).length).toBe(3);
    expect((view.activities as { type: string }[]).map((a) => a.type).sort()).toEqual(
      ['note_added', 'stage_changed', 'submission_received'].sort(),
    );
    expect((await auditRows(fixture.workspaceId)).at(-1)).toMatchObject({
      action: 'lead.data_exported',
      result: 'success',
      actor_id: admin.userId,
    });
  });

  it('AC-CRM-06: 404 for a lead of another workspace', async () => {
    const c = createCommands();
    const { leadId } = await submitRealLead(other);

    const result = await c.exportLeadData({
      actor: actorOf('admin'),
      leadId,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });
});

describe.skipIf(!hasAnonymizeFunction)('anonymizeLead through Postgres', () => {
  it('AC-CRM-09: the preview changes nothing; a confirmed plan erases the PII and frees the e-mail', async () => {
    const c = createCommands();
    const { leadId, submit } = await submitRealLead(fixture, 'carla@acme.com.br');
    const admin = actorOf('admin');
    const before = await tableCounts(fixture.workspaceId);
    const leadBefore = await leadRow(leadId);

    const preview = await c.anonymizeLead({
      actor: admin,
      leadId,
      body: json({}),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });
    expect(preview).toMatchObject({ ok: true, value: { mode: 'preview', leadVersion: 1 } });
    if (!preview.ok || preview.value.mode !== 'preview') return;
    expect(await tableCounts(fixture.workspaceId)).toEqual(before);
    expect(await leadRow(leadId)).toEqual(leadBefore);

    const applied = await c.anonymizeLead({
      actor: admin,
      leadId,
      body: json({ confirm: true, plan_hash: preview.value.planHash }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });

    expect(applied).toMatchObject({ ok: true, value: { mode: 'applied', leadId } });
    const scrubbed = await db.admin<{ blob: string }[]>`
      SELECT (
        (SELECT row_to_json(l)::text FROM crm.leads l WHERE id = ${leadId}) ||
        coalesce((SELECT string_agg(row_to_json(s)::text, '') FROM capture.submissions s WHERE lead_id = ${leadId}), '')
      ) AS blob
    `;
    expect(scrubbed[0]?.blob).not.toMatch(/carla|menezes|acme|203\.0\.113\.7|IwAR123/i);
    expect(await activityTypes(leadId)).toContain('anonymized');
    expect(
      (await auditRows(fixture.workspaceId))
        .filter((r) => r.action.startsWith('lead.anonymiz'))
        .map((r) => `${r.action}:${r.result}`),
    ).toEqual(['lead.anonymize_previewed:success', 'lead.anonymized:success']);
    // the same e-mail becomes a new lead
    const again = await submit.submit({
      email: 'carla@acme.com.br',
      first_name: 'Carla',
      last_name: 'Menezes',
    });
    expect(again.ok).toBe(true);
    const count = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.leads WHERE workspace_id = ${fixture.workspaceId} AND anonymized_at IS NULL
    `;
    expect(count[0]?.n).toBe(1);
    // a second application is a conflict, a replay of the first key is not
    const second = await c.anonymizeLead({
      actor: admin,
      leadId,
      body: json({ confirm: true, plan_hash: preview.value.planHash }),
      idempotencyKey: KEY_2,
      correlationId: CORRELATION,
    });
    expect(second).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
  });

  it('ST-26: a plan issued before the lead changed is stale and erases nothing', async () => {
    const c = createCommands();
    const { leadId } = await submitRealLead(fixture);
    const admin = actorOf('admin');
    const preview = await c.anonymizeLead({
      actor: admin,
      leadId,
      body: json({}),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });
    if (!preview.ok || preview.value.mode !== 'preview') throw new Error('expected a preview');
    await c.changeLeadStage({
      actor: admin,
      leadId,
      body: stageBody(1),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });

    const result = await c.anonymizeLead({
      actor: admin,
      leadId,
      body: json({ confirm: true, plan_hash: preview.value.planHash }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'plan_stale' } });
    expect((await leadRow(leadId))?.anonymized_at).toBeNull();
  });

  it('the inventory counts what the database holds', async () => {
    const { leadId } = await submitRealLead(fixture);
    const c = createCommands();
    await c.addLeadNote({
      actor: actorOf('admin'),
      leadId,
      body: json({ body: 'n' }),
      idempotencyKey: KEY_1,
      correlationId: CORRELATION,
    });

    const inventory = await c.uow.run(fixture.workspaceId, (tx) =>
      createPostgresAnonymizationGateway().inventory(tx, fixture.workspaceId, leadId),
    );

    expect(inventory).toEqual({
      submissionFields: 1,
      submissionMessages: 0,
      submissionTrackingIdentifiers: 1,
      submissionIpAndUserAgent: 1,
      activityNotes: 1,
    });
  });

  it('AC-CRM-06: 404 for a lead of another workspace', async () => {
    const c = createCommands();
    const { leadId } = await submitRealLead(other);

    const result = await c.anonymizeLead({
      actor: actorOf('admin'),
      leadId,
      body: json({}),
      idempotencyKey: null,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });
});

describe.skipIf(!hasMembers)('PostgresMemberDirectory', () => {
  it("knows only the active members of the transaction's workspace", async () => {
    const c = createCommands();
    const active = ids.uuidv7() as UserId;
    const inactive = ids.uuidv7() as UserId;
    const foreign = ids.uuidv7() as UserId;
    await addMember(fixture.workspaceId, active);
    await addMember(fixture.workspaceId, inactive, false);
    await addMember(other.workspaceId, foreign);
    const directory = createPostgresMemberDirectory();

    const answers = await c.uow.run(fixture.workspaceId, async (tx) => [
      await directory.isActiveMember(tx, fixture.workspaceId, active),
      await directory.isActiveMember(tx, fixture.workspaceId, inactive),
      await directory.isActiveMember(tx, fixture.workspaceId, foreign),
      await directory.isActiveMember(tx, other.workspaceId, foreign),
    ]);

    expect(answers).toEqual([true, false, false, false]);
  });
});
