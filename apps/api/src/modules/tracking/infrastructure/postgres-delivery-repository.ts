import type { DeliveryRepository } from '#/modules/tracking/application/ports.ts';
import { Delivery } from '#/modules/tracking/domain/delivery.ts';
import {
  DELIVERY_STATUSES,
  DESTINATIONS,
  type DeliveryStatus,
  type Destination,
} from '#/modules/tracking/domain/destinations.ts';
import type { TransactionSqlResolver } from '#/modules/tracking/infrastructure/transaction-sql.ts';
import type { IdGenerator, OutboxEventId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

interface DeliveryRow {
  readonly outbox_event_id: string;
  readonly destination: string;
  readonly status: string;
  readonly attempts: number;
  readonly last_http_status: number | null;
  readonly last_error_code: string | null;
  readonly external_ref: string | null;
  readonly updated_at: Date;
}

function isDestination(value: string): value is Destination {
  return (DESTINATIONS as readonly string[]).includes(value);
}

function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}

function toDelivery(row: DeliveryRow): Delivery {
  // The table CHECKs make these unreachable; failing loudly beats guessing a state.
  if (!isDestination(row.destination) || !isDeliveryStatus(row.status)) {
    throw new Error('tracking.deliveries row violates its CHECK constraints');
  }
  return Delivery.rehydrate({
    outboxEventId: row.outbox_event_id as OutboxEventId,
    destination: row.destination,
    status: row.status,
    attempts: row.attempts,
    lastHttpStatus: row.last_http_status,
    lastErrorCode: row.last_error_code,
    externalRef: row.external_ref,
    updatedAt: row.updated_at,
  });
}

/**
 * `tracking.deliveries` through the caller's transaction. Idempotency lives in the database:
 * `UNIQUE (outbox_event_id, destination)` + `ON CONFLICT DO NOTHING` (ADR-0004), and `save` only
 * ever updates a delivery that is still open, so a terminal state never regresses.
 */
export class PostgresDeliveryRepository implements DeliveryRepository {
  readonly #sqlOf: TransactionSqlResolver;
  readonly #ids: IdGenerator;

  constructor(sqlOf: TransactionSqlResolver, ids: IdGenerator) {
    this.#sqlOf = sqlOf;
    this.#ids = ids;
  }

  async ensureOpen(
    tx: Transaction,
    workspaceId: WorkspaceId,
    outboxEventId: OutboxEventId,
    destinations: readonly Destination[],
  ): Promise<void> {
    const sql = this.#sqlOf(tx);
    for (const destination of destinations) {
      await sql`
        INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination, status)
        VALUES (${this.#ids.uuidv7()}, ${outboxEventId}, ${workspaceId}, ${destination}, 'pending')
        ON CONFLICT (outbox_event_id, destination) DO NOTHING
      `;
    }
  }

  async listForEvent(tx: Transaction, outboxEventId: OutboxEventId): Promise<readonly Delivery[]> {
    const rows = await this.#sqlOf(tx)<DeliveryRow[]>`
      SELECT outbox_event_id, destination, status, attempts, last_http_status, last_error_code,
             external_ref, updated_at
      FROM tracking.deliveries
      WHERE outbox_event_id = ${outboxEventId} AND workspace_id = core.current_workspace_id()
      ORDER BY destination ASC
      LIMIT 10
    `;
    return rows.map(toDelivery);
  }

  async save(tx: Transaction, delivery: Delivery): Promise<boolean> {
    const state = delivery.snapshot();
    const updated = await this.#sqlOf(tx)<{ id: string }[]>`
      UPDATE tracking.deliveries
      SET status = ${state.status}, attempts = ${state.attempts},
          last_http_status = ${state.lastHttpStatus}, last_error_code = ${state.lastErrorCode},
          external_ref = ${state.externalRef}
      WHERE outbox_event_id = ${state.outboxEventId}
        AND destination = ${state.destination}
        AND workspace_id = core.current_workspace_id()
        AND status IN ('pending', 'failed')
      RETURNING id
    `;
    return updated.length > 0;
  }
}
