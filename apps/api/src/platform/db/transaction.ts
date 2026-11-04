import type { Transaction } from '#/shared/unit-of-work.ts';
import type { TransactionSql } from './client.ts';

/** Transactions handed out by `PostgresUnitOfWork`; anything else is refused by `unwrapTransaction`. */
const openTransactions = new WeakSet<object>();

/**
 * Brands a driver transaction as the opaque `Transaction` of the application layer. Only the unit of
 * work calls this, right after it opened the transaction and set the workspace scope.
 */
export function wrapTransaction(tx: TransactionSql): Transaction {
  openTransactions.add(tx);
  // The brand is a compile-time device; at runtime the handle is the driver transaction itself.
  return tx as unknown as Transaction;
}

/**
 * Recovers the driver transaction inside a module's infrastructure. Throws for a handle that did not
 * come from `PostgresUnitOfWork` (a fake, or a hand-made object), so a repository can never run
 * outside the workspace scope that the unit of work established.
 */
export function unwrapTransaction(tx: Transaction): TransactionSql {
  if (!openTransactions.has(tx)) {
    throw new TypeError('transaction handle was not created by PostgresUnitOfWork');
  }
  return tx as unknown as TransactionSql;
}
