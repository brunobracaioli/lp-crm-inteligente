import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type { ConsentRecord, ConsentRepository } from '#/modules/lead-capture/application/ports.ts';

/** `capture.consents` (append-only: `lp_api` has no UPDATE/DELETE, and triggers reject them anyway). */
export function createPostgresConsentRepository(): ConsentRepository {
  return {
    async appendMany(tx: Transaction, consents: readonly ConsentRecord[]): Promise<void> {
      if (consents.length === 0) {
        return;
      }
      const sql = unwrapTransaction(tx);
      // Bulk-insert helper: the column list is a fixed literal, values stay bound parameters.
      const rows = consents.map((consent) => ({
        id: consent.id,
        workspace_id: consent.workspaceId,
        lead_id: consent.leadId,
        submission_id: consent.submissionId,
        purpose: consent.purpose,
        granted: consent.granted,
        policy_version: consent.policyVersion,
        created_at: consent.createdAt,
      }));
      await sql`
        INSERT INTO capture.consents ${sql(
          rows,
          'id',
          'workspace_id',
          'lead_id',
          'submission_id',
          'purpose',
          'granted',
          'policy_version',
          'created_at',
        )}
      `;
    },
  };
}
