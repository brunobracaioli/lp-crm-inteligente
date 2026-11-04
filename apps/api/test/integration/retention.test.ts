import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import { FixtureScope, aLeadState, type WorkspaceFixture } from './support/fixtures.ts';
import {
  daysAgo,
  insertActivity,
  insertAuditEntry,
  insertOutboxEvent,
  insertSubmission,
} from './support/retention.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

// Mirrors supabase/tests/007_retention.test.sql (pgTAP cannot run on the Docker-less local database).
// Fixtures sit at least a day away from each cutoff because now() differs between statements here.
const INSUFFICIENT_PRIVILEGE = '42501';
const RESTRICT_VIOLATION = '23001';
const DAYS_PER_MONTH = 30.4375;
const OLDEST_DAYS = 3650;

const ids = new RandomUuidV7Generator();
const leads = createPostgresLeadRepository();

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

async function seedLead(
  fixture: WorkspaceFixture,
  overrides: Parameters<typeof aLeadState>[2] = {},
) {
  const lead = aLeadState(fixture.workspaceId, ids, overrides);
  await uow.run(fixture.workspaceId, (tx) => leads.insertIfAbsent(tx, lead));
  return lead;
}

interface PiiRow {
  readonly id: string;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
  readonly pii_purged_at: Date | null;
  readonly ip_hmac: string;
}

async function piiRows(fixture: WorkspaceFixture): Promise<Map<string, PiiRow>> {
  const rows = await db.admin<PiiRow[]>`
    SELECT id, pg_catalog.host(client_ip) AS client_ip, user_agent, pii_purged_at, ip_hmac
    FROM capture.submissions WHERE workspace_id = ${fixture.workspaceId}
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

describe('capture.purge_submission_pii (30 days)', () => {
  it('nulls IP and user agent of old submissions and leaves newer ones untouched', async () => {
    const fixture = await scope.workspace();
    const lead = await seedLead(fixture);
    const base = { ...fixture, leadId: lead.id, clientIp: '203.0.113.7', userAgent: 'agent/1.0' };
    const old = await insertSubmission(db.admin, ids, { ...base, createdAt: daysAgo(31) });
    const recent = await insertSubmission(db.admin, ids, { ...base, createdAt: daysAgo(29) });

    await db.admin`SELECT capture.purge_submission_pii()`;
    const rows = await piiRows(fixture);

    expect(rows.get(old)).toMatchObject({ client_ip: null, user_agent: null });
    expect(rows.get(old)?.pii_purged_at).toBeInstanceOf(Date);
    expect(rows.get(old)?.ip_hmac).toBe('b'.repeat(64));
    expect(rows.get(recent)).toMatchObject({
      client_ip: '203.0.113.7',
      user_agent: 'agent/1.0',
      pii_purged_at: null,
    });
  });

  it('is idempotent: a second run changes nothing', async () => {
    const fixture = await scope.workspace();
    const lead = await seedLead(fixture);
    const old = await insertSubmission(db.admin, ids, {
      ...fixture,
      leadId: lead.id,
      clientIp: '203.0.113.7',
      userAgent: 'agent/1.0',
      createdAt: daysAgo(OLDEST_DAYS),
    });

    await db.admin`SELECT capture.purge_submission_pii()`;
    const first = (await piiRows(fixture)).get(old)?.pii_purged_at;
    const secondRun = await db.admin<{ n: number }[]>`SELECT capture.purge_submission_pii() AS n`;
    const second = (await piiRows(fixture)).get(old)?.pii_purged_at;

    expect(secondRun[0]?.n).toBe(0);
    expect(second).toEqual(first);
  });

  it('works in batches: each run handles at most batch size x max batches rows', async () => {
    const fixture = await scope.workspace();
    const lead = await seedLead(fixture);
    for (let index = 0; index < 5; index += 1) {
      await insertSubmission(db.admin, ids, {
        ...fixture,
        leadId: lead.id,
        clientIp: '203.0.113.7',
        userAgent: 'agent/1.0',
        createdAt: daysAgo(OLDEST_DAYS + index),
      });
    }

    const run = (batchSize: number, maxBatches: number) =>
      db.admin<
        { n: number }[]
      >`SELECT capture.purge_submission_pii(${batchSize}, ${maxBatches}) AS n`;
    const purged = async () =>
      [...(await piiRows(fixture)).values()].filter((row) => row.pii_purged_at !== null).length;

    expect((await run(2, 1))[0]?.n).toBe(2);
    expect(await purged()).toBe(2);
    expect((await run(2, 2))[0]?.n).toBe(3);
    expect(await purged()).toBe(5);
  });

  it('rejects out-of-range batch parameters', async () => {
    await expect(db.admin`SELECT capture.purge_submission_pii(0, 1)`).rejects.toMatchObject({
      code: '22023',
    });
    await expect(db.admin`SELECT capture.purge_submission_pii(10, 0)`).rejects.toMatchObject({
      code: '22023',
    });
  });
});

describe('tracking.purge_completed_outbox (90 days)', () => {
  it('deletes only done events past the cutoff, together with their deliveries', async () => {
    const fixture = await scope.workspace();
    const lead = await seedLead(fixture);
    const common = { workspaceId: fixture.workspaceId, leadId: lead.id };
    const doneOld = await insertOutboxEvent(db.admin, ids, {
      ...common,
      status: 'done',
      processedAt: daysAgo(91),
      deliveryStatuses: ['sent', 'skipped_no_consent'],
    });
    const doneRecent = await insertOutboxEvent(db.admin, ids, {
      ...common,
      status: 'done',
      processedAt: daysAgo(89),
      deliveryStatuses: ['sent'],
    });
    const pendingOld = await insertOutboxEvent(db.admin, ids, {
      ...common,
      status: 'pending',
      processedAt: null,
      deliveryStatuses: ['pending'],
    });
    const processingOld = await insertOutboxEvent(db.admin, ids, {
      ...common,
      status: 'processing',
      processedAt: daysAgo(200),
    });
    const deadOld = await insertOutboxEvent(db.admin, ids, {
      ...common,
      status: 'dead',
      processedAt: daysAgo(200),
      deliveryStatuses: ['dead'],
    });
    const doneWithRetryable = await insertOutboxEvent(db.admin, ids, {
      ...common,
      status: 'done',
      processedAt: daysAgo(200),
      deliveryStatuses: ['failed'],
    });

    await db.admin`SELECT tracking.purge_completed_outbox()`;
    const events = await db.admin<{ id: string }[]>`
      SELECT id FROM tracking.outbox_events WHERE workspace_id = ${fixture.workspaceId}
    `;
    const deliveries = await db.admin<{ outbox_event_id: string }[]>`
      SELECT outbox_event_id FROM tracking.deliveries WHERE workspace_id = ${fixture.workspaceId}
    `;

    expect(events.map((row) => row.id).sort()).toEqual(
      [doneRecent, pendingOld, processingOld, deadOld, doneWithRetryable].sort(),
    );
    expect(events.map((row) => row.id)).not.toContain(doneOld);
    expect(deliveries.map((row) => row.outbox_event_id)).not.toContain(doneOld);
    expect(deliveries).toHaveLength(4);
  });
});

describe('core.purge_audit_log (12 months)', () => {
  it('deletes entries older than 12 months and keeps the rest', async () => {
    const fixture = await scope.workspace();
    const old = await insertAuditEntry(
      db.admin,
      ids,
      fixture.workspaceId,
      daysAgo(12 * DAYS_PER_MONTH + 2),
    );
    const recent = await insertAuditEntry(
      db.admin,
      ids,
      fixture.workspaceId,
      daysAgo(12 * DAYS_PER_MONTH - 2),
    );

    await db.admin`SELECT core.purge_audit_log()`;
    const rows = await db.admin<{ id: string }[]>`
      SELECT id::text AS id FROM core.audit_log WHERE workspace_id = ${fixture.workspaceId}
    `;

    expect(rows.map((row) => Number(row.id))).toEqual([recent]);
    expect(rows.map((row) => Number(row.id))).not.toContain(old);
  });

  it('keeps the table append-only outside the purge function, even with a forged flag', async () => {
    const fixture = await scope.workspace();
    const old = await insertAuditEntry(db.admin, ids, fixture.workspaceId, daysAgo(OLDEST_DAYS));
    const recent = await insertAuditEntry(db.admin, ids, fixture.workspaceId, daysAgo(1));

    // No flag: not even an old entry can be deleted.
    await expect(db.admin`DELETE FROM core.audit_log WHERE id = ${old}`).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
    // Flag on: a young entry is still protected, and UPDATE never is allowed.
    await expect(
      db.admin.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('app.retention_purge', 'on', true)`;
        await tx`DELETE FROM core.audit_log WHERE id = ${recent}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      db.admin.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('app.retention_purge', 'on', true)`;
        await tx`UPDATE core.audit_log SET result = 'error' WHERE id = ${old}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });
});

describe('crm.anonymize_inactive_leads (24 months)', () => {
  it('anonymizes inactive non-won leads across workspaces and spares the others', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const inactive = (months: number) => daysAgo(months * DAYS_PER_MONTH);
    const staleA = await seedLead(a, { lastSubmittedAt: inactive(25) });
    const staleB = await seedLead(b, { lastSubmittedAt: inactive(26), stage: 'contacted' });
    const wonOld = await seedLead(a, { lastSubmittedAt: inactive(30), stage: 'won' });
    const fresh = await seedLead(a, { lastSubmittedAt: inactive(23) });
    const touched = await seedLead(a, { lastSubmittedAt: inactive(30) });
    await insertActivity(db.admin, ids, {
      workspaceId: a.workspaceId,
      leadId: touched.id,
      type: 'note_added',
      data: { body: 'called back yesterday' },
      createdAt: daysAgo(10),
    });

    const result = await db.admin<{ n: number }[]>`SELECT crm.anonymize_inactive_leads() AS n`;
    const rows = await db.admin<{ id: string; anonymized: boolean; email: string }[]>`
      SELECT id, anonymized_at IS NOT NULL AS anonymized, email
      FROM crm.leads WHERE workspace_id IN (${a.workspaceId}, ${b.workspaceId})
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const activities = await db.admin<
      { lead_id: string; actor_type: string; actor_id: string | null }[]
    >`
      SELECT lead_id, actor_type, actor_id FROM crm.lead_activities
      WHERE workspace_id IN (${a.workspaceId}, ${b.workspaceId}) AND type = 'anonymized'
    `;

    expect(result[0]?.n).toBe(2);
    expect(byId.get(staleA.id)?.anonymized).toBe(true);
    expect(byId.get(staleB.id)?.anonymized).toBe(true);
    expect(byId.get(wonOld.id)?.anonymized).toBe(false);
    expect(byId.get(fresh.id)?.anonymized).toBe(false);
    expect(byId.get(touched.id)?.anonymized).toBe(false);
    expect(byId.get(wonOld.id)?.email).toBe(wonOld.email);
    expect(activities.map((row) => row.lead_id).sort()).toEqual([staleA.id, staleB.id].sort());
    expect(activities.every((row) => row.actor_type === 'system' && row.actor_id === null)).toBe(
      true,
    );
  });

  it('is idempotent', async () => {
    const fixture = await scope.workspace();
    await seedLead(fixture, { lastSubmittedAt: daysAgo(30 * DAYS_PER_MONTH) });

    await db.admin`SELECT crm.anonymize_inactive_leads()`;
    const second = await db.admin<{ n: number }[]>`SELECT crm.anonymize_inactive_leads() AS n`;
    const activities = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.lead_activities
      WHERE workspace_id = ${fixture.workspaceId} AND type = 'anonymized'
    `;

    expect(second[0]?.n).toBe(0);
    expect(activities[0]?.n).toBe(1);
  });
});

describe('privileges and scheduling', () => {
  it('lp_api cannot execute any purge function or the unchecked anonymizer', async () => {
    const denied = { code: INSUFFICIENT_PRIVILEGE };
    await expect(db.app`SELECT capture.purge_submission_pii()`).rejects.toMatchObject(denied);
    await expect(db.app`SELECT tracking.purge_completed_outbox()`).rejects.toMatchObject(denied);
    await expect(db.app`SELECT core.purge_audit_log()`).rejects.toMatchObject(denied);
    await expect(db.app`SELECT crm.anonymize_inactive_leads()`).rejects.toMatchObject(denied);
    await expect(
      db.app`SELECT crm.anonymize_lead_unchecked(
        ${ids.uuidv7()}::uuid, ${ids.uuidv7()}::uuid, 'system', NULL, ${ids.uuidv7()}::uuid)`,
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('every retention function is SECURITY DEFINER with an empty search_path', async () => {
    const rows = await db.admin<{ name: string; secdef: boolean; config: string | null }[]>`
      SELECT n.nspname || '.' || p.proname AS name, p.prosecdef AS secdef, pg_catalog.array_to_string(p.proconfig, ',') AS config
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname || '.' || p.proname IN (
        'capture.purge_submission_pii', 'tracking.purge_completed_outbox', 'core.purge_audit_log',
        'crm.anonymize_inactive_leads', 'crm.anonymize_lead_unchecked', 'crm.anonymize_lead'
      )
    `;

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.secdef, row.name).toBe(true);
      expect(row.config, row.name).toBe('search_path=""');
    }
  });

  it('schedules the four retention jobs in pg_cron', async () => {
    const jobs = await db.admin<{ jobname: string; schedule: string; command: string }[]>`
      SELECT jobname, schedule, command FROM cron.job WHERE jobname LIKE 'lp-retention-%'
      ORDER BY jobname
    `;

    expect(jobs).toEqual([
      {
        jobname: 'lp-retention-anonymize-inactive-leads',
        schedule: '0 4 * * *',
        command: 'SELECT crm.anonymize_inactive_leads()',
      },
      {
        jobname: 'lp-retention-purge-audit-log',
        schedule: '45 3 1 * *',
        command: 'SELECT core.purge_audit_log()',
      },
      {
        jobname: 'lp-retention-purge-completed-outbox',
        schedule: '30 3 * * *',
        command: 'SELECT tracking.purge_completed_outbox()',
      },
      {
        jobname: 'lp-retention-purge-submission-pii',
        schedule: '15 3 * * *',
        command: 'SELECT capture.purge_submission_pii()',
      },
    ]);
  });
});
