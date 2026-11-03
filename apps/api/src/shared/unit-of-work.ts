import type { WorkspaceId } from '#/shared/ids.ts';

declare const transactionBrand: unique symbol;

/**
 * Opaque handle for an open database transaction. Application code only passes it along;
 * each module's infrastructure unwraps it to its driver transaction. This lets lead-capture and
 * crm write in the same commit (ADR-0001) without either knowing the other's repositories.
 */
export interface Transaction {
  readonly [transactionBrand]: true;
}

export interface UnitOfWork {
  /**
   * Runs `work` inside one transaction scoped to `workspaceId` (sets `app.workspace_id` for RLS).
   * Commits when `work` resolves, rolls back when it rejects.
   */
  run<T>(workspaceId: WorkspaceId, work: (tx: Transaction) => Promise<T>): Promise<T>;
}
