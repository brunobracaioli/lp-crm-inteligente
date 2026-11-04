import type { TrackingTelemetry } from '#/modules/tracking/application/ports.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';

type DeliveryRecorded = Parameters<TrackingTelemetry['deliveryRecorded']>[0];

const COUNT = 1;

function levelFor(status: DeliveryRecorded['status']): 'info' | 'warn' | 'error' {
  if (status === 'dead') return 'error';
  if (status === 'failed') return 'warn';
  return 'info';
}

/**
 * Structured logs + Vercel Custom Metrics for the dispatcher and the sweeper (000-overview §5.3).
 * Fields are IDs and closed codes only: no PII, no token, no third-party response body. A `dead`
 * delivery or event logs at `error` with an `alert` key the log drain rule matches (wave 6b).
 */
export class LoggingTrackingTelemetry implements TrackingTelemetry {
  readonly #logger: Logger;
  readonly #metrics: Metrics;

  constructor(logger: Logger, metrics: Metrics) {
    this.#logger = logger;
    this.#metrics = metrics;
  }

  deliveryRecorded(event: DeliveryRecorded): void {
    this.#metrics.record('delivery.result', COUNT, {
      destination: event.destination,
      status: event.status,
    });
    this.#logger[levelFor(event.status)](
      {
        correlation_id: event.correlationId,
        outbox_event_id: event.outboxEventId,
        destination: event.destination,
        status: event.status,
        attempts: event.attempts,
        http_status: event.httpStatus,
        error_code: event.errorCode,
        ...(event.status === 'dead' ? { alert: 'delivery_dead' } : {}),
      },
      'delivery recorded',
    );
  }

  outboxLag(seconds: number): void {
    this.#metrics.record('outbox.lag_s', seconds);
  }

  outboxDead(event: Parameters<TrackingTelemetry['outboxDead']>[0]): void {
    // Metric for the `lp-outbox-dead` monitor (ops/vercel/monitors.json); the log keeps the IDs.
    this.#metrics.record('outbox.dead', COUNT, { reason: event.reason });
    this.#logger.error(
      {
        correlation_id: event.correlationId,
        outbox_event_id: event.outboxEventId,
        reason: event.reason,
        alert: 'outbox_event_dead',
      },
      'outbox event dead-lettered',
    );
  }

  anomaly(event: Parameters<TrackingTelemetry['anomaly']>[0]): void {
    this.#logger.warn(
      {
        correlation_id: event.correlationId,
        outbox_event_id: event.outboxEventId,
        code: event.code,
      },
      'outbox anomaly',
    );
  }
}
