import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSqlClient } from '#/platform/db/client.ts';
import { createPostgresAuditLogWriter } from '#/platform/db/postgres-audit-log-writer.ts';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { CorrelationId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import { createPostgresFormLookup } from '#/modules/lead-capture/infrastructure/postgres-form-lookup.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import { FixtureScope, aLeadState, countRows } from './support/fixtures.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

/** SQLSTATE for both a failed RLS WITH CHECK and a missing table privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

const ids = new RandomUuidV7Generator();
const leads = createPostgresLeadRepository();

let db: TestDatabase;
let scope: FixtureScope;

beforeAll(async () => {
  // One connection: the pooled-connection leak checks below must reuse it.
  db = await openTestDatabase({ maxConnections: 1 });
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

describe('PostgresUnitOfWork', () => {
  it('scopes the transaction to the workspace and forgets it afterwards (set_config is local)', async () => {
    const { workspaceId } = await scope.workspace();
    const uow = createPostgresUnitOfWork(db.app);

    const inside = await uow.run(workspaceId, async (tx) => {
      const sql = unwrapTransaction(tx);
      const rows = await sql<{ value: string }[]>`
        SELECT pg_catalog.current_setting('app.workspace_id', true) AS value
      `;
      return rows[0]?.value;
    });
    // Same single connection, new transaction: the previous scope must be gone.
    const after = await db.app<{ value: string | null; visible: string | null }[]>`
      SELECT
        pg_catalog.current_setting('app.workspace_id', true) AS value,
        core.current_workspace_id()::text AS visible
    `;

    expect(inside).toBe(workspaceId);
    expect(after[0]?.value === null || after[0]?.value === '').toBe(true);
    expect(after[0]?.visible).toBeNull();
  });

  it('commits when the work resolves and rolls back when it rejects', async () => {
    const { workspaceId } = await scope.workspace();
    const uow = createPostgresUnitOfWork(db.app);
    const committed = aLeadState(workspaceId, ids);
    const discarded = aLeadState(workspaceId, ids);

    await uow.run(workspaceId, (tx) => leads.insertIfAbsent(tx, committed));
    await expect(
      uow.run(workspaceId, async (tx) => {
        await leads.insertIfAbsent(tx, discarded);
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    const stored = await db.admin<{ email: string }[]>`
      SELECT email FROM crm.leads WHERE workspace_id = ${workspaceId} ORDER BY email
    `;
    expect(stored.map((row) => row.email)).toEqual([committed.email]);
  });

  it('refuses a transaction handle that it did not create', async () => {
    const { workspaceId } = await scope.workspace();
    const foreign = Object.freeze({}) as unknown as Transaction;

    await expect(leads.insertIfAbsent(foreign, aLeadState(workspaceId, ids))).rejects.toThrow(
      TypeError,
    );
  });

  it('applies the statement timeout and reports it as a database outage (503)', async () => {
    const { workspaceId } = await scope.workspace();
    const uow = createPostgresUnitOfWork(db.app, { statementTimeoutMs: 100 });

    await expect(
      uow.run(workspaceId, async (tx) => {
        await unwrapTransaction(tx)`SELECT pg_catalog.pg_sleep(2)`;
      }),
    ).rejects.toMatchObject({
      name: 'DependencyUnavailableError',
      dependency: 'database',
      cause: { code: '57014' },
    });
  });

  it('reports an unreachable database as a dependency outage (503)', async () => {
    const unreachable = createSqlClient(
      { url: 'postgresql://lp_api:unused@127.0.0.1:1/postgres' },
      { connectTimeoutSeconds: 1 },
    );
    const uow = createPostgresUnitOfWork(unreachable);

    try {
      await expect(
        uow.run(ids.uuidv7() as WorkspaceId, () => Promise.resolve()),
      ).rejects.toMatchObject({ name: 'DependencyUnavailableError', dependency: 'database' });
    } finally {
      await unreachable.end({ timeout: 1 });
    }
  });
});

describe('Row-Level Security (database §5): cross-tenant access', () => {
  it('a transaction of workspace A cannot read the leads of workspace B', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const uow = createPostgresUnitOfWork(db.app);
    const leadOfB = aLeadState(b.workspaceId, ids);
    await uow.run(b.workspaceId, (tx) => leads.insertIfAbsent(tx, leadOfB));

    const seenFromA = await uow.run(a.workspaceId, async (tx) => ({
      byAdapter: await leads.findActiveByEmailForUpdate(tx, b.workspaceId, leadOfB.email),
      byRawQuery: await unwrapTransaction(tx)<{ id: string }[]>`
        SELECT id FROM crm.leads WHERE id = ${leadOfB.id}
      `,
    }));
    const seenFromB = await uow.run(b.workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, b.workspaceId, leadOfB.email),
    );

    expect(seenFromA.byAdapter).toBeNull();
    expect(seenFromA.byRawQuery).toEqual([]);
    expect(seenFromB?.id).toBe(leadOfB.id);
  });

  it('a transaction of workspace A cannot write rows of workspace B', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const uow = createPostgresUnitOfWork(db.app);
    const leadOfB = aLeadState(b.workspaceId, ids);
    await uow.run(b.workspaceId, (tx) => leads.insertIfAbsent(tx, leadOfB));

    // INSERT of a row tagged with B: rejected by WITH CHECK.
    await expect(
      uow.run(a.workspaceId, (tx) => leads.insertIfAbsent(tx, aLeadState(b.workspaceId, ids))),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    // UPDATE of B's row: invisible, so zero rows match and the adapter reports a conflict.
    const outcome = await uow.run(a.workspaceId, (tx) =>
      leads.update(tx, { ...leadOfB, firstName: 'Hijacked' }, leadOfB.version),
    );
    // Audit rows follow the same rule.
    await expect(
      uow.run(a.workspaceId, (tx) =>
        createPostgresAuditLogWriter().append(tx, {
          workspaceId: b.workspaceId,
          occurredAt: new Date('2026-11-03T12:00:00.000Z'),
          actorType: 'system',
          actorId: null,
          action: 'test.cross_tenant',
          resourceType: 'lead',
          resourceId: leadOfB.id,
          result: 'success',
          correlationId: ids.uuidv7() as CorrelationId,
          metadata: {},
        }),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    const stored = await db.admin<{ first_name: string }[]>`
      SELECT first_name FROM crm.leads WHERE id = ${leadOfB.id}
    `;
    expect(outcome).toBe('version_conflict');
    expect(stored[0]?.first_name).toBe(leadOfB.firstName);
    expect((await countRows(db.admin, b.workspaceId)).audit).toBe(0);
  });

  it('without a workspace scope no tenant row is visible', async () => {
    const a = await scope.workspace();
    const uow = createPostgresUnitOfWork(db.app);
    await uow.run(a.workspaceId, (tx) => leads.insertIfAbsent(tx, aLeadState(a.workspaceId, ids)));

    const unscoped = await db.app<{ id: string }[]>`
      SELECT id FROM crm.leads WHERE workspace_id = ${a.workspaceId}
    `;

    expect(unscoped).toEqual([]);
  });

  it('lp_api cannot delete rows or touch core.forms beyond reading active ones', async () => {
    const a = await scope.workspace();
    const paused = await scope.workspace({ formStatus: 'paused' });
    const forms = createPostgresFormLookup(db.app);

    await expect(
      db.app`DELETE FROM crm.leads WHERE workspace_id = ${a.workspaceId}`,
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      db.app`UPDATE core.forms SET status = 'archived' WHERE form_key = ${a.formKey}`,
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect((await forms.findActiveByKey(a.formKey))?.workspaceId).toBe(a.workspaceId);
    expect(await forms.findActiveByKey(paused.formKey)).toBeNull();
  });
});
