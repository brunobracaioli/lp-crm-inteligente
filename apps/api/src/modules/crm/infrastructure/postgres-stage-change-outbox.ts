import { createHash } from 'node:crypto';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  StageChangedEvent,
  StageChangeOutbox,
} from '#/modules/crm/application/commands/ports.ts';

/** Fixed namespace of the deterministic outbox ids (UUID v5); not a secret. */
const STAGE_EVENT_NAMESPACE = '6f1c2d84-3b7a-5e0c-9a41-2c8d5b7e9f10';
const UUID_VERSION_5 = 0x50;
const UUID_VARIANT_RFC = 0x80;
const BYTE_VERSION = 6;
const BYTE_VARIANT = 8;

/** RFC 9562 §5.5 name-based UUID (SHA-1) — deterministic, so the same name always gives the same id. */
export function uuidV5(name: string, namespace: string = STAGE_EVENT_NAMESPACE): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[BYTE_VERSION] = ((bytes[BYTE_VERSION] ?? 0) & 0x0f) | UUID_VERSION_5;
  bytes[BYTE_VARIANT] = ((bytes[BYTE_VARIANT] ?? 0) & 0x3f) | UUID_VARIANT_RFC;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic outbox id for "this lead reached this stage" (`event_id = uuidv5(lead_id:stage)`). */
export function stageEventId(leadId: string, stage: string): string {
  return uuidV5(`${leadId}:${stage}`);
}

/**
 * `tracking.outbox_events` row `lead.stage_changed` (crm §4, offline conversions of Onda 11b).
 * The id is derived from lead + stage and the insert is `ON CONFLICT DO NOTHING`, so re-qualifying
 * a reopened lead (or a retried request) never creates a second conversion. The payload carries
 * IDs and the stage code only.
 */
export function createPostgresStageChangeOutbox(): StageChangeOutbox {
  return {
    async enqueue(tx: Transaction, event: StageChangedEvent): Promise<void> {
      const sql = unwrapTransaction(tx);
      await sql`
        INSERT INTO tracking.outbox_events (
          id, workspace_id, aggregate_type, aggregate_id, event_type, payload, created_at
        ) VALUES (
          ${stageEventId(event.leadId, event.toStage)}, ${event.workspaceId}, 'lead', ${event.leadId},
          'lead.stage_changed',
          ${sql.json({ lead_id: event.leadId, to_stage: event.toStage })},
          ${event.occurredAt}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    },
  };
}
