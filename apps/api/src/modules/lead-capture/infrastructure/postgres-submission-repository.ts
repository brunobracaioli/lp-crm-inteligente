import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { EventId, IdempotencyKey, SubmissionId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  StoredSubmissionReference,
  SubmissionRecord,
  SubmissionRepository,
} from '#/modules/lead-capture/application/ports.ts';

const referenceRowSchema = z.strictObject({
  id: z.guid(),
  event_id: z.guid(),
  request_hash: z.string(),
});

const conflictRowSchema = z.strictObject({
  idempotency_key: z.guid(),
  event_id: z.guid(),
});

type InsertOutcome = 'inserted' | 'duplicate_idempotency_key' | 'duplicate_event_id';

/** Failed submission insert whose conflict matches neither UNIQUE (the primary key, i.e. a bug). */
export class UnexpectedSubmissionConflictError extends Error {
  constructor() {
    super('submission insert conflicted but no idempotency key or event id matched');
    this.name = 'UnexpectedSubmissionConflictError';
  }
}

/**
 * `capture.submissions`. Conflicts never abort the transaction (`ON CONFLICT DO NOTHING`), so the
 * use case can still read the stored submission or retry with a new event id. Which UNIQUE was hit
 * is resolved by a follow-up read in the same transaction: the idempotency key wins, because it
 * routes the request to the replay path.
 */
export function createPostgresSubmissionRepository(): SubmissionRepository {
  return {
    async insert(tx: Transaction, submission: SubmissionRecord): Promise<InsertOutcome> {
      const sql = unwrapTransaction(tx);
      const { attribution, consentState, antibot } = submission;
      const inserted = await sql<object[]>`
        INSERT INTO capture.submissions (
          id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, message,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id,
          gclid, gbraid, wbraid, fbclid, ttclid, msclkid, fbp, fbc, ga_client_id,
          landing_page_url, referrer_url, consent_state, client_ip, user_agent, ip_hmac, antibot,
          created_at
        ) VALUES (
          ${submission.id}, ${submission.workspaceId}, ${submission.formId}, ${submission.leadId},
          ${submission.idempotencyKey}, ${submission.requestHash}, ${submission.eventId},
          ${sql.json({ ...submission.fields })}, ${submission.message},
          ${attribution.utmSource}, ${attribution.utmMedium}, ${attribution.utmCampaign},
          ${attribution.utmTerm}, ${attribution.utmContent}, ${attribution.utmId},
          ${attribution.gclid}, ${attribution.gbraid}, ${attribution.wbraid}, ${attribution.fbclid},
          ${attribution.ttclid}, ${attribution.msclkid}, ${attribution.fbp}, ${attribution.fbc},
          ${attribution.gaClientId}, ${attribution.landingPageUrl}, ${attribution.referrerUrl},
          ${sql.json({
            analytics_storage: consentState.analyticsStorage,
            ad_storage: consentState.adStorage,
            ad_user_data: consentState.adUserData,
            ad_personalization: consentState.adPersonalization,
          })},
          ${submission.clientIp}, ${submission.userAgent}, ${submission.ipHmac},
          ${sql.json({
            provider: antibot.provider,
            challenge_age_seconds: antibot.challengeAgeSeconds,
            ephemeral_id: antibot.ephemeralId,
          })},
          ${submission.createdAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted.length > 0) {
        return 'inserted';
      }
      return classifyConflict(tx, submission);
    },

    async findByIdempotencyKey(
      tx: Transaction,
      workspaceId: WorkspaceId,
      key: IdempotencyKey,
    ): Promise<StoredSubmissionReference | null> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT id, event_id, request_hash
        FROM capture.submissions
        WHERE workspace_id = ${workspaceId} AND idempotency_key = ${key}
      `;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const stored = referenceRowSchema.parse(row);
      return {
        submissionId: stored.id as SubmissionId,
        eventId: stored.event_id as EventId,
        requestHash: stored.request_hash,
      };
    },
  };
}

async function classifyConflict(
  tx: Transaction,
  submission: SubmissionRecord,
): Promise<Exclude<InsertOutcome, 'inserted'>> {
  const sql = unwrapTransaction(tx);
  const rows = await sql<object[]>`
    SELECT idempotency_key, event_id
    FROM capture.submissions
    WHERE workspace_id = ${submission.workspaceId}
      AND (idempotency_key = ${submission.idempotencyKey} OR event_id = ${submission.eventId})
    ORDER BY created_at, id
    LIMIT 2
  `;
  const conflicts = rows.map((row) => conflictRowSchema.parse(row));
  if (conflicts.some((row) => row.idempotency_key === submission.idempotencyKey)) {
    return 'duplicate_idempotency_key';
  }
  if (conflicts.some((row) => row.event_id === submission.eventId)) {
    return 'duplicate_event_id';
  }
  throw new UnexpectedSubmissionConflictError();
}
