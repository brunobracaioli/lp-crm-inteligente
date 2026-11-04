import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresStaffMembershipResolver } from '#/platform/auth/staff-membership.ts';
import { createSqlClient } from '#/platform/db/client.ts';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { createPostgresStaffDirectory } from '#/modules/crm/infrastructure/postgres-staff-directory.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import { FixtureScope } from './support/fixtures.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

/**
 * Membership resolution through the real `lp_api` role (RLS on), mirroring supabase/tests/009_workspace_members
 * (which needs pgTAP). Covers threat model ST-08 (no/inactive membership), ST-14/15 (cross-tenant) and ST-38.
 */

const INSUFFICIENT_PRIVILEGE = '42501';
const ids = new RandomUuidV7Generator();

let db: TestDatabase;
let scope: FixtureScope;

beforeAll(async () => {
  // One connection: the pooled-connection leak checks must reuse it.
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

interface MemberFixture {
  readonly workspaceId: WorkspaceId;
  readonly userId?: UserId;
  readonly displayName?: string;
  readonly role?: 'owner' | 'admin' | 'sales' | 'viewer';
  readonly active?: boolean;
}

async function addMember(fixture: MemberFixture): Promise<UserId> {
  const userId = fixture.userId ?? (ids.uuidv7() as UserId);
  await db.admin`
    INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role, active)
    VALUES (
      ${fixture.workspaceId}, ${userId}, ${fixture.displayName ?? 'Marina Souza'},
      ${fixture.role ?? 'sales'}, ${fixture.active ?? true}
    )
  `;
  return userId;
}

const resolver = () => createPostgresStaffMembershipResolver(db.app);

describe('PostgresStaffMembershipResolver', () => {
  it('resolves workspace, role and display name of an active member', async () => {
    const { workspaceId } = await scope.workspace();
    const userId = await addMember({ workspaceId, role: 'admin', displayName: 'Ana Admin' });

    const result = await resolver().resolve(userId);

    expect(result).toEqual({
      kind: 'member',
      membership: { workspaceId, role: 'admin', displayName: 'Ana Admin' },
    });
  });

  it('resolves nothing for an inactive member (ST-08)', async () => {
    const { workspaceId } = await scope.workspace();
    const userId = await addMember({ workspaceId, active: false });

    expect(await resolver().resolve(userId)).toEqual({ kind: 'none' });
  });

  it('cuts access as soon as the member is deactivated, with no cache in between', async () => {
    const { workspaceId } = await scope.workspace();
    const userId = await addMember({ workspaceId });
    expect((await resolver().resolve(userId)).kind).toBe('member');

    await db.admin`
      UPDATE core.workspace_members SET active = false
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `;

    expect(await resolver().resolve(userId)).toEqual({ kind: 'none' });
  });

  it('resolves nothing for an authenticated user that was never provisioned', async () => {
    expect(await resolver().resolve(ids.uuidv7() as UserId)).toEqual({ kind: 'none' });
  });

  it('ignores an inactive membership in another workspace', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const userId = await addMember({ workspaceId: a.workspaceId, role: 'owner' });
    await addMember({ workspaceId: b.workspaceId, userId, role: 'viewer', active: false });

    const result = await resolver().resolve(userId);

    expect(result).toMatchObject({
      kind: 'member',
      membership: { workspaceId: a.workspaceId, role: 'owner' },
    });
  });

  it('fails closed as ambiguous when the user is active in two workspaces', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const userId = await addMember({ workspaceId: a.workspaceId });
    await addMember({ workspaceId: b.workspaceId, userId });

    expect(await resolver().resolve(userId)).toEqual({ kind: 'ambiguous' });
  });

  it('never resolves a membership of somebody else (the key is the verified sub only)', async () => {
    const { workspaceId } = await scope.workspace();
    const member = await addMember({ workspaceId, displayName: 'Dona do Workspace' });
    const stranger = ids.uuidv7() as UserId;

    expect(await resolver().resolve(stranger)).toEqual({ kind: 'none' });
    expect((await resolver().resolve(member)).kind).toBe('member');
  });

  it('forgets the user setting after the transaction (pooled connection stays clean)', async () => {
    const { workspaceId } = await scope.workspace();
    const userId = await addMember({ workspaceId });
    await resolver().resolve(userId);

    // Same single connection, no transaction setting: the policy must match nothing.
    const [setting] = await db.app<{ value: string | null; visible: string | null }[]>`
      SELECT
        pg_catalog.current_setting('app.staff_user_id', true) AS value,
        core.current_staff_user_id()::text AS visible
    `;
    const visible =
      await db.app`SELECT user_id FROM core.workspace_members WHERE user_id = ${userId}`;

    expect(setting?.value === null || setting?.value === '').toBe(true);
    expect(setting?.visible).toBeNull();
    expect(visible).toHaveLength(0);
  });

  it('reports a database outage as DependencyUnavailableError (503), not as no membership', async () => {
    const unreachable = createSqlClient(
      { url: 'postgresql://lp_api:x@127.0.0.1:1/postgres' },
      { connectTimeoutSeconds: 1, maxConnections: 1 },
    );
    try {
      await expect(
        createPostgresStaffMembershipResolver(unreachable).resolve(ids.uuidv7() as UserId),
      ).rejects.toBeInstanceOf(DependencyUnavailableError);
    } finally {
      await unreachable.end({ timeout: 1 });
    }
  });
});

describe('core.workspace_members as lp_api (ST-38, cross-tenant)', () => {
  it('sees no row without any setting (deny by default)', async () => {
    const { workspaceId } = await scope.workspace();
    await addMember({ workspaceId });

    const rows =
      await db.app`SELECT 1 FROM core.workspace_members WHERE workspace_id = ${workspaceId}`;

    expect(rows).toHaveLength(0);
  });

  it('lists only the members of the workspace of the unit of work', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const shared = await addMember({ workspaceId: a.workspaceId, displayName: 'Compartilhada' });
    await addMember({ workspaceId: b.workspaceId, userId: shared, displayName: 'Compartilhada' });
    await addMember({ workspaceId: b.workspaceId, displayName: 'Só do B' });
    const uow = createPostgresUnitOfWork(db.app);

    const visibleFromA = await uow.run(a.workspaceId, async (tx) => {
      const sql = unwrapTransaction(tx);
      return sql<{ workspace_id: string }[]>`SELECT workspace_id FROM core.workspace_members`;
    });
    const bByPrimaryKey = await uow.run(a.workspaceId, async (tx) => {
      const sql = unwrapTransaction(tx);
      return sql`SELECT 1 FROM core.workspace_members WHERE workspace_id = ${b.workspaceId}`;
    });

    expect(visibleFromA.map((row) => row.workspace_id)).toEqual([a.workspaceId]);
    expect(bByPrimaryKey).toHaveLength(0);
  });

  it('cannot insert, update or delete members (no role escalation through the API)', async () => {
    const { workspaceId } = await scope.workspace();
    const userId = await addMember({ workspaceId, role: 'viewer' });
    const uow = createPostgresUnitOfWork(db.app);

    const attempt = (work: (sql: ReturnType<typeof unwrapTransaction>) => Promise<unknown>) =>
      uow.run(workspaceId, (tx) => work(unwrapTransaction(tx)));

    await expect(
      attempt(
        (sql) => sql`
        INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
        VALUES (${workspaceId}, ${ids.uuidv7()}, 'Mallory', 'owner')`,
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      attempt(
        (sql) => sql`UPDATE core.workspace_members SET role = 'owner' WHERE user_id = ${userId}`,
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      attempt((sql) => sql`DELETE FROM core.workspace_members WHERE user_id = ${userId}`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('enforces role and display-name constraints at the database', async () => {
    const { workspaceId } = await scope.workspace();
    const insert = (displayName: string, role: string) =>
      db.admin`
        INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
        VALUES (${workspaceId}, ${ids.uuidv7()}, ${displayName}, ${role})`;

    await expect(insert('Eve', 'superuser')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('', 'sales')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('x'.repeat(81), 'sales')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('Bob‮evil', 'sales')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('Line\nbreak', 'sales')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(' padded ', 'sales')).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a duplicate membership and a membership of a missing workspace', async () => {
    const { workspaceId } = await scope.workspace();
    const userId = await addMember({ workspaceId });

    await expect(addMember({ workspaceId, userId })).rejects.toMatchObject({ code: '23505' });
    await expect(addMember({ workspaceId: ids.uuidv7() as WorkspaceId })).rejects.toMatchObject({
      code: '23503',
    });
  });
});

describe('PostgresStaffDirectory', () => {
  it('lists active and inactive members of the workspace only, ordered by name', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const zed = await addMember({ workspaceId: a.workspaceId, displayName: 'Zed', role: 'viewer' });
    const abel = await addMember({
      workspaceId: a.workspaceId,
      displayName: 'Abel',
      role: 'owner',
    });
    const gone = await addMember({
      workspaceId: a.workspaceId,
      displayName: 'Gone',
      role: 'sales',
      active: false,
    });
    await addMember({ workspaceId: b.workspaceId, displayName: 'Outsider' });
    const directory = createPostgresStaffDirectory(createPostgresUnitOfWork(db.app));

    const members = await directory.listMembers(a.workspaceId);

    expect(members).toEqual([
      { userId: abel, displayName: 'Abel', role: 'owner', active: true },
      { userId: gone, displayName: 'Gone', role: 'sales', active: false },
      { userId: zed, displayName: 'Zed', role: 'viewer', active: true },
    ]);
  });

  it('caps the list at 200 members (contract maxItems)', async () => {
    const { workspaceId } = await scope.workspace();
    await db.admin`
      INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
      SELECT ${workspaceId}, gen_random_uuid(), 'Member ' || n, 'viewer'
      FROM generate_series(1, 205) AS n
    `;
    const directory = createPostgresStaffDirectory(createPostgresUnitOfWork(db.app));

    expect(await directory.listMembers(workspaceId)).toHaveLength(200);
  });

  it('returns the name of the workspace, and null for one that does not exist', async () => {
    const { workspaceId } = await scope.workspace();
    const directory = createPostgresStaffDirectory(createPostgresUnitOfWork(db.app));

    expect(await directory.workspaceName(workspaceId)).toBe('Integration test workspace');
    expect(await directory.workspaceName(ids.uuidv7() as WorkspaceId)).toBeNull();
  });
});
