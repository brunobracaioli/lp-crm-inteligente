import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type { MemberDirectory } from '#/modules/crm/application/commands/ports.ts';

/**
 * `core.workspace_members` (read-only for `lp_api`, created by the staff-auth slice). An inactive
 * member, a member of another workspace and a stranger all answer `false`.
 */
export function createPostgresMemberDirectory(): MemberDirectory {
  return {
    async isActiveMember(
      tx: Transaction,
      workspaceId: WorkspaceId,
      userId: UserId,
    ): Promise<boolean> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT 1 AS found
        FROM core.workspace_members
        WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND active
      `;
      return rows.length > 0;
    },
  };
}
