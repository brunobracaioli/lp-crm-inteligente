import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  AnonymizationGateway,
  ErasureInventory,
} from '#/modules/crm/application/commands/ports.ts';

const inventoryRowSchema = z.strictObject({
  submission_fields: z.number().int(),
  submission_messages: z.number().int(),
  submission_tracking_identifiers: z.number().int(),
  submission_ip_and_user_agent: z.number().int(),
  activity_notes: z.number().int(),
});

const anonymizeRowSchema = z.strictObject({ anonymized: z.boolean() });

/**
 * Erasure side of the LGPD operations. `inventory` counts what `crm.anonymize_lead` will scrub (for
 * the preview and the plan fingerprint); `anonymize` calls that SECURITY DEFINER function (Onda 6b)
 * inside the caller's workspace-scoped transaction. The function writes the `anonymized` activity;
 * the audit row is the caller's.
 */
export function createPostgresAnonymizationGateway(): AnonymizationGateway {
  return {
    async inventory(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
    ): Promise<ErasureInventory> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT
          count(*) FILTER (WHERE fields <> '{}'::jsonb)::int AS submission_fields,
          count(*) FILTER (WHERE message IS NOT NULL)::int AS submission_messages,
          count(*) FILTER (
            WHERE coalesce(gclid, gbraid, wbraid, fbclid, ttclid, msclkid, fbp, fbc, ga_client_id)
              IS NOT NULL
          )::int AS submission_tracking_identifiers,
          count(*) FILTER (WHERE client_ip IS NOT NULL OR user_agent IS NOT NULL)::int
            AS submission_ip_and_user_agent,
          (
            SELECT count(*)::int
            FROM crm.lead_activities
            WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId} AND type = 'note_added'
          ) AS activity_notes
        FROM capture.submissions
        WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId}
      `;
      const row = inventoryRowSchema.parse(rows[0]);
      return {
        submissionFields: row.submission_fields,
        submissionMessages: row.submission_messages,
        submissionTrackingIdentifiers: row.submission_tracking_identifiers,
        submissionIpAndUserAgent: row.submission_ip_and_user_agent,
        activityNotes: row.activity_notes,
      };
    },

    async anonymize(
      tx: Transaction,
      leadId: LeadId,
      actor: { readonly userId: UserId },
      correlationId: string,
    ): Promise<boolean> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT crm.anonymize_lead(${leadId}, 'user', ${actor.userId}, ${correlationId}) AS anonymized
      `;
      return anonymizeRowSchema.parse(rows[0]).anonymized;
    },
  };
}
