import { createSqlClient, type Sql } from '#/platform/db/client.ts';

/**
 * Local defaults for the stack started by `supabase start` (supabase/config.toml: db port 54722).
 * These are throwaway development credentials of a database that only exists on this machine; real
 * secrets never belong here and the suite refuses to run against anything but a loopback host.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://lp_api:lp_api_local_test@127.0.0.1:54722/postgres';
export const DEFAULT_TEST_ADMIN_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:54722/postgres';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const FORBIDDEN_CODE_INSUFFICIENT_PRIVILEGE = '42501';

export class NonLocalTestDatabaseError extends Error {
  constructor(variable: string) {
    super(
      `${variable} must point to a loopback host: integration tests never touch remote databases`,
    );
    this.name = 'NonLocalTestDatabaseError';
  }
}

function assertLoopback(variable: string, url: string): void {
  if (!LOOPBACK_HOSTS.has(new URL(url).hostname)) {
    throw new NonLocalTestDatabaseError(variable);
  }
}

export interface TestDatabase {
  /** Connected as `lp_api`, exactly like production: RLS applies. */
  readonly app: Sql;
  /** Connected as the local admin: fixtures, assertions and cleanup (bypasses RLS). */
  readonly admin: Sql;
  close(): Promise<void>;
}

export interface TestDatabaseOptions {
  readonly maxConnections?: number;
}

let rolePasswordSynced = false;

/**
 * `lp_api` is created without a password (ADR-0003). On the local stack the suite gives it the
 * password of `TEST_DATABASE_URL` so it can log in; this runs against loopback databases only.
 */
async function syncLocalRolePassword(admin: Sql, appUrl: string): Promise<void> {
  if (rolePasswordSynced) {
    return;
  }
  const password = decodeURIComponent(new URL(appUrl).password);
  await admin.begin(async (tx) => {
    await tx`SELECT pg_catalog.set_config('lp.test_role_password', ${password}, true)`;
    await tx`
      DO $$
      BEGIN
        EXECUTE pg_catalog.format('ALTER ROLE lp_api PASSWORD %L', pg_catalog.current_setting('lp.test_role_password'));
      END
      $$
    `;
  });
  rolePasswordSynced = true;
}

export async function openTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const appUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? DEFAULT_TEST_ADMIN_DATABASE_URL;
  assertLoopback('TEST_DATABASE_URL', appUrl);
  assertLoopback('TEST_ADMIN_DATABASE_URL', adminUrl);

  const admin = createSqlClient({ url: adminUrl }, { maxConnections: 2 });
  try {
    await syncLocalRolePassword(admin, appUrl);
  } catch (error) {
    await admin.end({ timeout: 1 });
    throw new Error(
      'cannot reach the local test database; run `supabase start && supabase db reset` first ' +
        '(docs/how-to/run-integration-tests.md)',
      { cause: error },
    );
  }
  const app = createSqlClient({ url: appUrl }, { maxConnections: options.maxConnections ?? 4 });
  return {
    app,
    admin,
    close: async () => {
      await app.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    },
  };
}

let cleanupSupported = true;

/**
 * Removes every row of the given workspaces. Append-only triggers reject DELETE for every role, so
 * the admin transaction runs in `replica` mode (triggers and FK checks off). If the local admin lacks
 * that privilege the cleanup is skipped: tests still never collide because each one owns a workspace.
 */
export async function purgeWorkspaces(admin: Sql, workspaceIds: readonly string[]): Promise<void> {
  if (!cleanupSupported || workspaceIds.length === 0) {
    return;
  }
  try {
    await admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = 'replica'`;
      for (const workspaceId of workspaceIds) {
        await tx`DELETE FROM tracking.deliveries WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM tracking.outbox_events WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM capture.consents WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM capture.submissions WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM crm.lead_activities WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM crm.leads WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM core.audit_log WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM core.forms WHERE workspace_id = ${workspaceId}`;
        await tx`DELETE FROM core.workspaces WHERE id = ${workspaceId}`;
      }
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== FORBIDDEN_CODE_INSUFFICIENT_PRIVILEGE) {
      throw error;
    }
    cleanupSupported = false;
  }
}
