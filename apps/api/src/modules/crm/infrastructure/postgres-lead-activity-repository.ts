import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  LeadActivityRecord,
  LeadActivityRepository,
} from '#/modules/crm/application/ports.ts';

/** `crm.lead_activities` (append-only timeline; `data` holds IDs and codes only, at most 8 KB). */
export function createPostgresLeadActivityRepository(): LeadActivityRepository {
  return {
    async append(tx: Transaction, activity: LeadActivityRecord): Promise<void> {
      const sql = unwrapTransaction(tx);
      await sql`
        INSERT INTO crm.lead_activities (
          id, workspace_id, lead_id, type, actor_type, actor_id, data, created_at
        ) VALUES (
          ${activity.id}, ${activity.workspaceId}, ${activity.leadId}, ${activity.type},
          ${activity.actorType}, ${activity.actorId}, ${sql.json({ ...activity.data })},
          ${activity.createdAt}
        )
      `;
    },
  };
}
