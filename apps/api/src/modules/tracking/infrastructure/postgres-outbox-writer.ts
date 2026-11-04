import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type { OutboxEventDraft } from '#/modules/tracking/public-api.ts';

/**
 * Structurally identical to the lead-capture `OutboxWriter` port: the table belongs to tracking,
 * and modules never import each other's internals, so the shape is declared here.
 */
export interface PostgresOutboxWriter {
  /** Inserts the event as `pending` in the caller's transaction (transactional outbox, R6). */
  enqueue(tx: Transaction, event: OutboxEventDraft): Promise<void>;
}

/** `tracking.outbox_events`. The payload carries IDs only, never PII (database §3.7). */
export function createPostgresOutboxWriter(): PostgresOutboxWriter {
  return {
    async enqueue(tx: Transaction, event: OutboxEventDraft): Promise<void> {
      const sql = unwrapTransaction(tx);
      await sql`
        INSERT INTO tracking.outbox_events (
          id, workspace_id, aggregate_type, aggregate_id, event_type, payload, created_at
        ) VALUES (
          ${event.id}, ${event.workspaceId}, ${event.aggregateType}, ${event.aggregateId},
          ${event.eventType},
          ${sql.json({
            lead_id: event.payload.lead_id,
            submission_id: event.payload.submission_id,
          })},
          ${event.createdAt}
        )
      `;
    },
  };
}
