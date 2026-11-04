import { z } from 'zod';
import type {
  OutboxEventRecord,
  OutboxLockResult,
  OutboxRepository,
  OutboxStatus,
  StaleOutboxQuery,
} from '#/modules/tracking/application/ports.ts';
import type { TransactionSqlResolver } from '#/modules/tracking/infrastructure/transaction-sql.ts';
import type { LeadCapturedPayload, OutboxEventType } from '#/modules/tracking/public-api.ts';
import type { OutboxEventId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

/** Shape of `payload` for `lead.captured` (database §3.7: IDs only, no PII). */
const leadCapturedPayloadSchema = z.object({ lead_id: z.uuid(), submission_id: z.uuid() }).strict();

interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly status: string;
  readonly attempts: number;
  readonly locked_until: Date | null;
  readonly created_at: Date;
}

const EVENT_TYPES: ReadonlySet<string> = new Set(['lead.captured', 'lead.stage_changed']);
const STATUSES: ReadonlySet<string> = new Set(['pending', 'processing', 'done', 'dead']);

function parsePayload(value: unknown): LeadCapturedPayload | null {
  const parsed = leadCapturedPayloadSchema.safeParse(value);
  return parsed.success
    ? ({
        lead_id: parsed.data.lead_id,
        submission_id: parsed.data.submission_id,
      } as LeadCapturedPayload)
    : null;
}

function toRecord(row: OutboxRow): OutboxEventRecord {
  // The table CHECKs make these unreachable; failing loudly beats guessing a status.
  if (!EVENT_TYPES.has(row.event_type) || !STATUSES.has(row.status)) {
    throw new Error('tracking.outbox_events row violates its CHECK constraints');
  }
  return {
    id: row.id as OutboxEventId,
    workspaceId: row.workspace_id as WorkspaceId,
    eventType: row.event_type as OutboxEventType,
    payload: parsePayload(row.payload),
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
  };
}

/**
 * `tracking.outbox_events` through the caller's transaction (RLS scopes every statement to the
 * workspace of the unit of work). Queries are parameterized tagged templates with explicit columns.
 */
export class PostgresOutboxRepository implements OutboxRepository {
  readonly #sqlOf: TransactionSqlResolver;

  constructor(sqlOf: TransactionSqlResolver) {
    this.#sqlOf = sqlOf;
  }

  async lockById(tx: Transaction, id: OutboxEventId): Promise<OutboxLockResult> {
    const sql = this.#sqlOf(tx);
    const locked = await sql<OutboxRow[]>`
      SELECT id, workspace_id, event_type, payload, status, attempts, locked_until, created_at
      FROM tracking.outbox_events
      WHERE id = ${id} AND workspace_id = core.current_workspace_id()
      FOR UPDATE SKIP LOCKED
    `;
    const [row] = locked;
    if (row !== undefined) {
      return { kind: 'locked', event: toRecord(row) };
    }
    // SKIP LOCKED hides a row held by another transaction; a plain read tells busy from missing.
    const visible = await sql<{ id: string }[]>`
      SELECT id FROM tracking.outbox_events
      WHERE id = ${id} AND workspace_id = core.current_workspace_id()
      LIMIT 1
    `;
    return visible.length > 0 ? { kind: 'busy' } : { kind: 'not_found' };
  }

  async markProcessing(tx: Transaction, id: OutboxEventId, lockedUntil: Date): Promise<void> {
    await this.#sqlOf(tx)`
      UPDATE tracking.outbox_events
      SET status = 'processing', attempts = attempts + 1, locked_until = ${lockedUntil}
      WHERE id = ${id} AND workspace_id = core.current_workspace_id()
    `;
  }

  async release(tx: Transaction, id: OutboxEventId, nextAttemptAt: Date): Promise<void> {
    await this.#sqlOf(tx)`
      UPDATE tracking.outbox_events
      SET status = 'pending', locked_until = NULL, next_attempt_at = ${nextAttemptAt}
      WHERE id = ${id} AND workspace_id = core.current_workspace_id()
    `;
  }

  async complete(
    tx: Transaction,
    id: OutboxEventId,
    result: { readonly status: 'done' | 'dead'; readonly processedAt: Date },
  ): Promise<void> {
    await this.#sqlOf(tx)`
      UPDATE tracking.outbox_events
      SET status = ${result.status}, processed_at = ${result.processedAt}, locked_until = NULL
      WHERE id = ${id} AND workspace_id = core.current_workspace_id()
    `;
  }

  async recordRepublish(tx: Transaction, id: OutboxEventId, nextAttemptAt: Date): Promise<void> {
    await this.#sqlOf(tx)`
      UPDATE tracking.outbox_events
      SET status = 'pending', attempts = attempts + 1, locked_until = NULL,
          next_attempt_at = ${nextAttemptAt}
      WHERE id = ${id} AND workspace_id = core.current_workspace_id()
    `;
  }

  async listStale(tx: Transaction, query: StaleOutboxQuery): Promise<readonly OutboxEventRecord[]> {
    // Served by outbox_events_sweeper_idx (status, next_attempt_at) WHERE status IN (pending, processing).
    const rows = await this.#sqlOf(tx)<OutboxRow[]>`
      SELECT id, workspace_id, event_type, payload, status, attempts, locked_until, created_at
      FROM tracking.outbox_events
      WHERE workspace_id = core.current_workspace_id()
        AND (
          (
            status = 'pending'
            AND next_attempt_at <= ${query.now}
            AND created_at < ${query.createdBefore}
          ) OR (
            status = 'processing'
            AND (locked_until IS NULL OR locked_until < ${query.now})
          )
        )
      ORDER BY created_at ASC, id ASC
      LIMIT ${query.limit}
      FOR UPDATE SKIP LOCKED
    `;
    return rows.map(toRecord);
  }
}
