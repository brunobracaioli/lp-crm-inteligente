import type {
  OutboxPublisher,
  OutboxRepository,
  TrackingTelemetry,
} from '#/modules/tracking/application/ports.ts';
import { MAX_OUTBOX_ATTEMPTS, retryDelayMs } from '#/modules/tracking/domain/retry-policy.ts';
import type { CorrelationId, OutboxEventId, WorkspaceId } from '#/shared/ids.ts';
import type { Clock } from '#/shared/time.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

/** Tracking §5.1: only events older than 2 minutes are republished (cover a failed post-commit publish). */
const DEFAULT_MIN_AGE_MS = 2 * 60_000;
/** Bounds one sweep: 50 sequential QStash publishes (5 s timeout each) stay inside a function run. */
const DEFAULT_BATCH_SIZE = 50;
const MS_PER_SECOND = 1_000;

export interface SweepOutboxCommand {
  /** Tenant of the sweep: trusted server config (the `lp_api` role cannot enumerate workspaces). */
  readonly workspaceId: WorkspaceId;
  readonly correlationId: CorrelationId;
}

export interface SweepOutboxResult {
  /** Events successfully handed to QStash again (the `republished` field of the response). */
  readonly republished: number;
  /** Events whose publish failed; they stay `pending` and the next sweep retries them. */
  readonly publishFailures: number;
  /** Events dead-lettered because they used up their attempts. */
  readonly deadLettered: number;
}

export type SweepOutbox = (command: SweepOutboxCommand) => Promise<SweepOutboxResult>;

export interface SweepOutboxDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly outbox: OutboxRepository;
  readonly publisher: OutboxPublisher;
  readonly telemetry: TrackingTelemetry;
  readonly clock: Clock;
  /** Uniform draw in [0, 1) for backoff jitter (`Math.random`). */
  readonly random: () => number;
  readonly minAgeMs?: number | undefined;
  readonly batchSize?: number | undefined;
}

interface SweepPlan {
  readonly toPublish: readonly OutboxEventId[];
  readonly deadLettered: number;
}

/**
 * Republishes outbox events that never reached `done` (tracking §5.1, ADR-0004): `pending` events
 * older than two minutes whose `next_attempt_at` is due, and `processing` events whose lease
 * expired (a worker died mid-dispatch). Bounded batch, oldest first, locked with
 * `FOR UPDATE SKIP LOCKED` so overlapping sweeps never take the same event.
 *
 * Each pick counts as an attempt; an event that already used {@link MAX_OUTBOX_ATTEMPTS} is
 * dead-lettered (with an alerting log) instead of being republished forever. Publishing happens
 * AFTER the planning transaction commits: no transaction is open during a QStash call, and a publish
 * that fails leaves the event `pending` for the next sweep. QStash's `deduplicationId` makes a
 * republish of an event it still holds harmless.
 */
export function createSweepOutbox(deps: SweepOutboxDependencies): SweepOutbox {
  const minAgeMs = deps.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  async function plan(command: SweepOutboxCommand): Promise<SweepPlan> {
    const { workspaceId, correlationId } = command;
    return deps.unitOfWork.run(workspaceId, async (tx): Promise<SweepPlan> => {
      const now = deps.clock.now();
      const stale = await deps.outbox.listStale(tx, {
        now,
        createdBefore: new Date(now.getTime() - minAgeMs),
        limit: batchSize,
      });
      const toPublish: OutboxEventId[] = [];
      let deadLettered = 0;
      for (const event of stale) {
        const ageSeconds = Math.max(0, now.getTime() - event.createdAt.getTime()) / MS_PER_SECOND;
        deps.telemetry.outboxLag(ageSeconds);
        if (event.attempts >= MAX_OUTBOX_ATTEMPTS) {
          await deps.outbox.complete(tx, event.id, { status: 'dead', processedAt: now });
          deps.telemetry.outboxDead({
            outboxEventId: event.id,
            reason: 'attempts_exhausted',
            correlationId,
          });
          deadLettered += 1;
          continue;
        }
        const delay = retryDelayMs(event.attempts + 1, deps.random());
        await deps.outbox.recordRepublish(tx, event.id, new Date(now.getTime() + delay));
        toPublish.push(event.id);
      }
      return { toPublish, deadLettered };
    });
  }

  return async (command) => {
    const { toPublish, deadLettered } = await plan(command);
    let republished = 0;
    let publishFailures = 0;
    for (const outboxEventId of toPublish) {
      try {
        await deps.publisher.publish(outboxEventId, { correlationId: command.correlationId });
        republished += 1;
      } catch {
        publishFailures += 1;
        deps.telemetry.anomaly({
          code: 'republish_failed',
          outboxEventId,
          correlationId: command.correlationId,
        });
      }
    }
    return { republished, publishFailures, deadLettered };
  };
}
