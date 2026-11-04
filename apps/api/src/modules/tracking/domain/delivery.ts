import type { OutboxEventId } from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import type { Destination, DeliveryStatus } from '#/modules/tracking/domain/destinations.ts';

/**
 * Total send attempts before a retryable failure becomes `dead` (tracking §5.1: "após 8
 * tentativas totais → dead + alerta"). QStash retries and the sweeper both count against it.
 */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** Result of one send attempt (structurally the same as `DeliveryAttemptResult` in the ports). */
export type AttemptOutcome =
  | { readonly status: 'sent'; readonly httpStatus: number; readonly externalRef: string | null }
  | {
      readonly status: 'retryable_failure';
      readonly httpStatus: number | null;
      readonly errorCode: string;
    }
  | {
      readonly status: 'permanent_failure';
      readonly httpStatus: number | null;
      readonly errorCode: string;
    };

/** `already_terminal`: the delivery reached `sent`, `skipped_*` or `dead` and never changes again. */
export type DeliveryTransitionError = 'already_terminal';

export interface DeliveryState {
  readonly outboxEventId: OutboxEventId;
  readonly destination: Destination;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly lastHttpStatus: number | null;
  /** Internal code, never a third-party response body (database §3.8). */
  readonly lastErrorCode: string | null;
  /** E.g. Meta `fbtrace_id`. */
  readonly externalRef: string | null;
  readonly updatedAt: Date;
}

const OPEN_STATUSES: ReadonlySet<DeliveryStatus> = new Set(['pending', 'failed']);

/**
 * One (outbox event, destination) delivery. Identity is that pair (database UNIQUE), which is what
 * makes reprocessing safe: a delivery that is not open is never sent again (AC-TR-04). Immutable:
 * every transition returns a new instance.
 */
export class Delivery implements DeliveryState {
  readonly outboxEventId: OutboxEventId;
  readonly destination: Destination;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly lastHttpStatus: number | null;
  readonly lastErrorCode: string | null;
  readonly externalRef: string | null;
  readonly updatedAt: Date;

  private constructor(state: DeliveryState) {
    this.outboxEventId = state.outboxEventId;
    this.destination = state.destination;
    this.status = state.status;
    this.attempts = state.attempts;
    this.lastHttpStatus = state.lastHttpStatus;
    this.lastErrorCode = state.lastErrorCode;
    this.externalRef = state.externalRef;
    this.updatedAt = state.updatedAt;
  }

  /** A new delivery, created lazily by the dispatcher for every enabled destination. */
  static open(outboxEventId: OutboxEventId, destination: Destination, now: Date): Delivery {
    return new Delivery({
      outboxEventId,
      destination,
      status: 'pending',
      attempts: 0,
      lastHttpStatus: null,
      lastErrorCode: null,
      externalRef: null,
      updatedAt: now,
    });
  }

  /** Rebuilds a delivery loaded from storage. */
  static rehydrate(state: DeliveryState): Delivery {
    return new Delivery(state);
  }

  /** True while the dispatcher still owes this destination an attempt (`pending` or `failed`). */
  get isOpen(): boolean {
    return OPEN_STATUSES.has(this.status);
  }

  /** True when QStash must be told to retry (`500`): a retryable failure with attempts left. */
  get awaitsRetry(): boolean {
    return this.status === 'failed';
  }

  skipForMissingConsent(now: Date): Result<Delivery, DeliveryTransitionError> {
    return this.transition(now, { status: 'skipped_no_consent' });
  }

  skipAsDisabled(now: Date): Result<Delivery, DeliveryTransitionError> {
    return this.transition(now, { status: 'skipped_disabled' });
  }

  /**
   * Applies the result of one send attempt. `sent` and `permanent_failure` are final;
   * `retryable_failure` keeps the delivery `failed` until the attempt budget is spent, then `dead`.
   */
  recordAttempt(
    outcome: AttemptOutcome,
    now: Date,
    maxAttempts: number = MAX_DELIVERY_ATTEMPTS,
  ): Result<Delivery, DeliveryTransitionError> {
    const attempts = this.attempts + 1;
    switch (outcome.status) {
      case 'sent':
        return this.transition(now, {
          status: 'sent',
          attempts,
          lastHttpStatus: outcome.httpStatus,
          lastErrorCode: null,
          externalRef: outcome.externalRef,
        });
      case 'permanent_failure':
        return this.transition(now, {
          status: 'dead',
          attempts,
          lastHttpStatus: outcome.httpStatus,
          lastErrorCode: outcome.errorCode,
        });
      case 'retryable_failure':
        return this.transition(now, {
          status: attempts >= maxAttempts ? 'dead' : 'failed',
          attempts,
          lastHttpStatus: outcome.httpStatus,
          lastErrorCode: outcome.errorCode,
        });
    }
  }

  /** Plain state for persistence (the repository maps it to `tracking.deliveries`). */
  snapshot(): DeliveryState {
    return {
      outboxEventId: this.outboxEventId,
      destination: this.destination,
      status: this.status,
      attempts: this.attempts,
      lastHttpStatus: this.lastHttpStatus,
      lastErrorCode: this.lastErrorCode,
      externalRef: this.externalRef,
      updatedAt: this.updatedAt,
    };
  }

  private transition(
    now: Date,
    changes: Partial<DeliveryState> & { readonly status: DeliveryStatus },
  ): Result<Delivery, DeliveryTransitionError> {
    if (!this.isOpen) {
      return err('already_terminal');
    }
    return ok(new Delivery({ ...this.snapshot(), ...changes, updatedAt: now }));
  }
}
