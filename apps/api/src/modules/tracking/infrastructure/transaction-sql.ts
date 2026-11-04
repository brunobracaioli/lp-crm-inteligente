import type { TransactionSql } from 'postgres';
import type { Transaction } from '#/shared/unit-of-work.ts';

/**
 * Unwraps the opaque `Transaction` of the unit of work into the driver handle of the transaction it
 * stands for. The Postgres `UnitOfWork` (composition root) owns the mapping; every Postgres adapter
 * of this module receives it by injection so it never learns how the handle is stored.
 *
 * The returned handle is already scoped to the workspace (`app.workspace_id`), so RLS applies to
 * every statement an adapter runs through it.
 */
export type TransactionSqlResolver = (tx: Transaction) => TransactionSql;
