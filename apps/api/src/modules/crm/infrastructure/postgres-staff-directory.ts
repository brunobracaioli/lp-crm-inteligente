import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import {
  MAX_LISTED_MEMBERS,
  type StaffDirectory,
  type StaffMemberRecord,
} from '#/modules/crm/application/staff-session.ts';
import type { UserId } from '#/shared/ids.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

const workspaceRowSchema = z.object({ name: z.string().min(1).max(120) }).strict();

const memberRowSchema = z
  .object({
    user_id: z.uuid(),
    display_name: z.string().min(1).max(80),
    role: z.enum(['owner', 'admin', 'sales', 'viewer']),
    active: z.boolean(),
  })
  .strict();

/**
 * Reads inside a unit of work scoped to the principal's workspace (`app.workspace_id`): the explicit
 * `workspace_id` filter and the RLS policy of both tables agree, so a bug in either still cannot cross tenants.
 */
export function createPostgresStaffDirectory(unitOfWork: UnitOfWork): StaffDirectory {
  return {
    async workspaceName(workspaceId) {
      const rows = await unitOfWork.run(workspaceId, async (tx) => {
        const sql = unwrapTransaction(tx);
        return sql`
          SELECT name FROM core.workspaces WHERE id = ${workspaceId} LIMIT 1
        `;
      });
      const [row] = rows;
      return row === undefined ? null : workspaceRowSchema.parse(row).name;
    },

    async listMembers(workspaceId) {
      const rows = await unitOfWork.run(workspaceId, async (tx) => {
        const sql = unwrapTransaction(tx);
        return sql`
          SELECT user_id, display_name, role, active
          FROM core.workspace_members
          WHERE workspace_id = ${workspaceId}
          ORDER BY display_name, user_id
          LIMIT ${MAX_LISTED_MEMBERS}
        `;
      });
      return rows.map((row): StaffMemberRecord => {
        const parsed = memberRowSchema.parse(row);
        return {
          userId: parsed.user_id as UserId,
          displayName: parsed.display_name,
          role: parsed.role,
          active: parsed.active,
        };
      });
    },
  };
}
