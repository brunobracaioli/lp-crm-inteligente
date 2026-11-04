import type { WorkspaceId } from '#/shared/ids.ts';
import type { Transaction, UnitOfWork } from '#/shared/unit-of-work.ts';
import type { Sql } from './client.ts';
import { wrapTransaction } from './transaction.ts';
import { translateDatabaseError } from './unavailable.ts';

export const DEFAULT_STATEMENT_TIMEOUT_MS = 3000;

export interface PostgresUnitOfWorkOptions {
  /** Applied (transaction-local) to every statement of the transaction. */
  readonly statementTimeoutMs?: number;
}

/**
 * `UnitOfWork` over `sql.begin`. The first statement scopes the transaction to the workspace
 * (`app.workspace_id`, read by `core.current_workspace_id()` in every RLS policy) with `is_local = true`,
 * so the setting dies with the transaction and never leaks to the next user of a pooled connection.
 * Commits when `work` resolves, rolls back (and rethrows the same error) when it rejects; a database
 * outage is rethrown as `DependencyUnavailableError('database')`.
 */
export function createPostgresUnitOfWork(
  sql: Sql,
  options: PostgresUnitOfWorkOptions = {},
): UnitOfWork {
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
    throw new RangeError('statementTimeoutMs must be a positive integer');
  }
  const timeoutSetting = String(statementTimeoutMs);

  return {
    async run<T>(workspaceId: WorkspaceId, work: (tx: Transaction) => Promise<T>): Promise<T> {
      // `begin` types its result through a conditional type that cannot be resolved for a generic T.
      try {
        const result: unknown = await sql.begin(async (tx) => {
          await tx`
            SELECT
              pg_catalog.set_config('app.workspace_id', ${workspaceId}, true),
              pg_catalog.set_config('statement_timeout', ${timeoutSetting}, true)
          `;
          return work(wrapTransaction(tx));
        });
        return result as T;
      } catch (error) {
        // An outage becomes 503; anything else (including the use case's own rejection) is rethrown.
        throw translateDatabaseError(error);
      }
    },
  };
}
