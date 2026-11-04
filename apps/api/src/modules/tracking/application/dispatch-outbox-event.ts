import type {
  ConversionDestination,
  DeliveryAttemptResult,
  DeliveryRepository,
  LeadConversionSource,
  LeadConversionSourceReader,
  OutboxEventRecord,
  OutboxRepository,
  TrackingTelemetry,
} from '#/modules/tracking/application/ports.ts';
import { prepareServerConversion } from '#/modules/tracking/application/prepare-server-conversion.ts';
import type { Delivery } from '#/modules/tracking/domain/delivery.ts';
import { retryDelayMs } from '#/modules/tracking/domain/retry-policy.ts';
import type { CorrelationId, OutboxEventId, WorkspaceId } from '#/shared/ids.ts';
import type { Clock } from '#/shared/time.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

/** How long a worker owns an event after claiming it (covers two sequential 5 s destination calls). */
const DEFAULT_LEASE_MS = 60_000;
const MS_PER_SECOND = 1_000;

export interface DispatchOutboxEventCommand {
  /** Tenant of the call: comes from trusted server config, never from the request (ADR-0006). */
  readonly workspaceId: WorkspaceId;
  readonly outboxEventId: OutboxEventId;
  readonly correlationId: CorrelationId;
}

/**
 * What the route must answer to QStash (tracking §5.1):
 * - `completed`, `already_processed`, `dead_lettered`, `not_found` → 200, nothing left to retry;
 * - `retry_later` → 500, QStash retries (`failed` deliveries with attempts left, or another worker
 *   still holds the event).
 */
export type DispatchOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'already_processed' }
  | { readonly kind: 'dead_lettered' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'retry_later'; readonly reason: 'delivery_failed' | 'busy' };

export type DispatchOutboxEvent = (command: DispatchOutboxEventCommand) => Promise<DispatchOutcome>;

export interface DispatchOutboxEventDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly outbox: OutboxRepository;
  readonly deliveries: DeliveryRepository;
  readonly sources: LeadConversionSourceReader;
  /** Enabled destinations only (e.g. `meta_capi`; `ga4_mp` when its flag is on). */
  readonly destinations: readonly ConversionDestination[];
  readonly telemetry: TrackingTelemetry;
  readonly clock: Clock;
  /** Uniform draw in [0, 1) for backoff jitter (`Math.random`). */
  readonly random: () => number;
  readonly leaseMs?: number | undefined;
}

type Claim =
  | { readonly kind: 'claimed'; readonly claimed: ClaimedEvent }
  | { readonly kind: 'skip'; readonly outcome: DispatchOutcome };

interface ClaimedEvent {
  readonly event: OutboxEventRecord;
  readonly attempts: number;
  readonly deliveries: readonly Delivery[];
  /** Loaded only when at least one delivery is still open. */
  readonly source: LeadConversionSource | null;
}

/**
 * Dispatches one outbox event (tracking §5.1, ADR-0004), in three short transactions so no database
 * transaction ever stays open across an outbound HTTP call (`idle_in_transaction_session_timeout`
 * is 5 s for `lp_api`):
 *
 * 1. claim: lock the row (`FOR UPDATE SKIP LOCKED`), take a lease, create the missing deliveries
 *    idempotently and load the conversion source;
 * 2. per open delivery: consent gate → destination call (no call when consent is denied) → persist
 *    the transition; `sent`/`skipped_*`/`dead` deliveries are never sent again (AC-TR-04);
 * 3. settle: every delivery terminal → event `done` (or `dead` if a delivery died); otherwise back
 *    to `pending` with a backoff + jitter `next_attempt_at` and a `retry_later` outcome.
 *
 * A crash after a successful send but before step 2 persists it re-sends on the retry; Meta
 * deduplicates by `event_id`, which is the same one the browser Pixel used.
 */
export function createDispatchOutboxEvent(
  deps: DispatchOutboxEventDependencies,
): DispatchOutboxEvent {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const destinationsByName = new Map(deps.destinations.map((d) => [d.name, d] as const));

  async function claimEvent(command: DispatchOutboxEventCommand): Promise<Claim> {
    const { workspaceId, outboxEventId, correlationId } = command;
    return deps.unitOfWork.run(workspaceId, async (tx): Promise<Claim> => {
      const locked = await deps.outbox.lockById(tx, outboxEventId);
      if (locked.kind === 'not_found') {
        deps.telemetry.anomaly({ code: 'event_not_found', outboxEventId, correlationId });
        return { kind: 'skip', outcome: { kind: 'not_found' } };
      }
      if (locked.kind === 'busy') {
        return busy(outboxEventId, correlationId);
      }
      const { event } = locked;
      const now = deps.clock.now();
      if (event.status === 'done' || event.status === 'dead') {
        return { kind: 'skip', outcome: { kind: 'already_processed' } };
      }
      if (event.status === 'processing' && event.lockedUntil !== null && event.lockedUntil > now) {
        return busy(outboxEventId, correlationId);
      }
      if (event.eventType !== 'lead.captured' || event.payload === null) {
        const reason = event.payload === null ? 'invalid_payload' : 'unsupported_event';
        await deps.outbox.complete(tx, outboxEventId, { status: 'dead', processedAt: now });
        deps.telemetry.outboxDead({ outboxEventId, reason, correlationId });
        return { kind: 'skip', outcome: { kind: 'dead_lettered' } };
      }

      deps.telemetry.outboxLag(
        Math.max(0, now.getTime() - event.createdAt.getTime()) / MS_PER_SECOND,
      );
      await deps.outbox.markProcessing(tx, outboxEventId, new Date(now.getTime() + leaseMs));
      await deps.deliveries.ensureOpen(
        tx,
        workspaceId,
        outboxEventId,
        deps.destinations.map((destination) => destination.name),
      );
      const existing = await deps.deliveries.listForEvent(tx, outboxEventId);
      const needsSource = existing.some((delivery) => delivery.isOpen && isEnabled(delivery));
      const source = needsSource ? await deps.sources.load(tx, workspaceId, event.payload) : null;
      return {
        kind: 'claimed',
        claimed: {
          event,
          attempts: event.attempts + 1,
          deliveries: existing,
          source,
        },
      };
    });
  }

  function busy(outboxEventId: OutboxEventId, correlationId: CorrelationId): Claim {
    deps.telemetry.anomaly({ code: 'event_busy', outboxEventId, correlationId });
    return { kind: 'skip', outcome: { kind: 'retry_later', reason: 'busy' } };
  }

  function isEnabled(delivery: Delivery): boolean {
    return destinationsByName.has(delivery.destination);
  }

  async function sendSafely(
    destination: ConversionDestination,
    source: LeadConversionSource,
  ): Promise<DeliveryAttemptResult | 'skipped_no_consent'> {
    const prepared = prepareServerConversion(source, destination.name);
    switch (prepared.kind) {
      case 'skipped':
        return 'skipped_no_consent';
      case 'invalid':
        return {
          status: 'permanent_failure',
          httpStatus: null,
          errorCode: `conversion_invalid_${prepared.error}`,
        };
      case 'ready':
        try {
          return await destination.send(prepared.event);
        } catch {
          // Adapters are meant to return a result; a throw is treated as a transient failure.
          return { status: 'retryable_failure', httpStatus: null, errorCode: 'destination_threw' };
        }
    }
  }

  /** The next state of one open delivery, performing its outbound call when consent allows it. */
  async function advance(
    delivery: Delivery,
    source: LeadConversionSource | null,
  ): Promise<Delivery> {
    const now = deps.clock.now();
    const destination = destinationsByName.get(delivery.destination);
    if (destination === undefined) {
      const skipped = delivery.skipAsDisabled(now);
      return skipped.ok ? skipped.value : delivery;
    }
    const outcome: DeliveryAttemptResult | 'skipped_no_consent' =
      source === null
        ? { status: 'permanent_failure', httpStatus: null, errorCode: 'lead_source_unavailable' }
        : await sendSafely(destination, source);
    const next =
      outcome === 'skipped_no_consent'
        ? delivery.skipForMissingConsent(deps.clock.now())
        : delivery.recordAttempt(outcome, deps.clock.now());
    return next.ok ? next.value : delivery;
  }

  async function settleDelivery(
    command: DispatchOutboxEventCommand,
    claimed: ClaimedEvent,
    delivery: Delivery,
  ): Promise<Delivery> {
    if (!delivery.isOpen) return delivery;
    const next = await advance(delivery, claimed.source);
    const saved = await deps.unitOfWork.run(command.workspaceId, (tx) =>
      deps.deliveries.save(tx, next),
    );
    if (!saved) {
      deps.telemetry.anomaly({
        code: 'delivery_state_conflict',
        outboxEventId: command.outboxEventId,
        correlationId: command.correlationId,
      });
    }
    deps.telemetry.deliveryRecorded({
      outboxEventId: command.outboxEventId,
      destination: next.destination,
      status: next.status,
      attempts: next.attempts,
      httpStatus: next.lastHttpStatus,
      errorCode: next.lastErrorCode,
      correlationId: command.correlationId,
    });
    return next;
  }

  async function settleEvent(
    command: DispatchOutboxEventCommand,
    claimed: ClaimedEvent,
    deliveries: readonly Delivery[],
  ): Promise<DispatchOutcome> {
    const { workspaceId, outboxEventId, correlationId } = command;
    const now = deps.clock.now();
    if (deliveries.every((delivery) => !delivery.isOpen)) {
      const dead = deliveries.some((delivery) => delivery.status === 'dead');
      await deps.unitOfWork.run(workspaceId, (tx) =>
        deps.outbox.complete(tx, outboxEventId, {
          status: dead ? 'dead' : 'done',
          processedAt: now,
        }),
      );
      if (dead) {
        deps.telemetry.outboxDead({ outboxEventId, reason: 'delivery_dead', correlationId });
      }
      return { kind: 'completed' };
    }
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs(claimed.attempts, deps.random()));
    await deps.unitOfWork.run(workspaceId, (tx) =>
      deps.outbox.release(tx, outboxEventId, nextAttemptAt),
    );
    return { kind: 'retry_later', reason: 'delivery_failed' };
  }

  return async (command) => {
    const claim = await claimEvent(command);
    if (claim.kind === 'skip') return claim.outcome;
    const { claimed } = claim;
    const settled: Delivery[] = [];
    for (const delivery of claimed.deliveries) {
      settled.push(await settleDelivery(command, claimed, delivery));
    }
    return settleEvent(command, claimed, settled);
  };
}
