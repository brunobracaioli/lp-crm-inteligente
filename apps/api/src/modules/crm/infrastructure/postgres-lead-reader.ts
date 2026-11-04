import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { LeadId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type { LeadReader } from '#/modules/crm/application/commands/ports.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import { leadStateFromRow } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';

/**
 * `crm.leads` by id for the staff commands. Both reads filter by the workspace of the credential
 * AND run under the transaction's `app.workspace_id` (RLS), so a lead of another workspace is
 * indistinguishable from a missing one. `findByIdForUpdate` serializes mutations, notes and the
 * anonymization of one lead.
 */
export function createPostgresLeadReader(): LeadReader {
  return {
    async findById(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
    ): Promise<LeadState | null> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT
          id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name,
          area_of_expertise, area_of_expertise_other, job_title, company_size, company_website,
          stage, lost_reason, score, score_band, score_breakdown, owner_user_id, marketing_opt_in,
          submissions_count, first_touch, last_touch, first_submitted_at, last_submitted_at,
          anonymized_at, version, created_at, updated_at
        FROM crm.leads
        WHERE workspace_id = ${workspaceId} AND id = ${leadId}
      `;
      const row = rows[0];
      return row === undefined ? null : leadStateFromRow(row);
    },

    async findByIdForUpdate(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
    ): Promise<LeadState | null> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT
          id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name,
          area_of_expertise, area_of_expertise_other, job_title, company_size, company_website,
          stage, lost_reason, score, score_band, score_breakdown, owner_user_id, marketing_opt_in,
          submissions_count, first_touch, last_touch, first_submitted_at, last_submitted_at,
          anonymized_at, version, created_at, updated_at
        FROM crm.leads
        WHERE workspace_id = ${workspaceId} AND id = ${leadId}
        FOR UPDATE
      `;
      const row = rows[0];
      return row === undefined ? null : leadStateFromRow(row);
    },
  };
}
