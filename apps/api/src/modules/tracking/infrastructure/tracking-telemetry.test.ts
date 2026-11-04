import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LoggingTrackingTelemetry } from '#/modules/tracking/infrastructure/tracking-telemetry.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';
import type { CorrelationId, OutboxEventId } from '#/shared/ids.ts';

const OUTBOX_EVENT_ID = '0192f3a0-1111-7222-8333-444455556666' as OutboxEventId;
const CORRELATION_ID = '0192f3a0-2222-7333-8444-555566667777' as CorrelationId;

function build() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const metrics = createRecordingMetrics();
  const telemetry = new LoggingTrackingTelemetry(
    createLogger({ level: 'info', appEnv: 'test', destination }),
    metrics,
  );
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { telemetry, metrics, logged };
}

const sentDelivery = {
  outboxEventId: OUTBOX_EVENT_ID,
  destination: 'meta_capi',
  status: 'sent',
  attempts: 1,
  httpStatus: 200,
  errorCode: null,
  correlationId: CORRELATION_ID,
} as const;

describe('LoggingTrackingTelemetry', () => {
  it('counts every delivery result with low-cardinality attributes only', () => {
    const { telemetry, metrics } = build();

    telemetry.deliveryRecorded(sentDelivery);
    telemetry.deliveryRecorded({ ...sentDelivery, status: 'failed', httpStatus: 503 });

    expect(metrics.records).toEqual([
      {
        name: 'delivery.result',
        value: 1,
        attributes: { destination: 'meta_capi', status: 'sent' },
      },
      {
        name: 'delivery.result',
        value: 1,
        attributes: { destination: 'meta_capi', status: 'failed' },
      },
    ]);
  });

  it('logs sent at info, failed at warn and dead at error with an alert key', () => {
    const { telemetry, logged } = build();

    telemetry.deliveryRecorded(sentDelivery);
    telemetry.deliveryRecorded({ ...sentDelivery, status: 'failed', errorCode: 'http_5xx' });
    telemetry.deliveryRecorded({ ...sentDelivery, status: 'dead', errorCode: 'validation_error' });

    const [sent, failed, dead] = logged();
    expect(sent).toMatchObject({ level: 'info', status: 'sent', outbox_event_id: OUTBOX_EVENT_ID });
    expect(failed).toMatchObject({ level: 'warn', error_code: 'http_5xx' });
    expect(dead).toMatchObject({ level: 'error', alert: 'delivery_dead' });
    expect(sent).not.toHaveProperty('alert');
  });

  it('records outbox lag as a metric', () => {
    const { telemetry, metrics } = build();

    telemetry.outboxLag(12.5);

    expect(metrics.records).toEqual([{ name: 'outbox.lag_s', value: 12.5, attributes: undefined }]);
  });

  it('logs a dead-lettered event at error with an alert key and the reason', () => {
    const { telemetry, logged, metrics } = build();

    telemetry.outboxDead({
      outboxEventId: OUTBOX_EVENT_ID,
      reason: 'attempts_exhausted',
      correlationId: CORRELATION_ID,
    });

    expect(logged()[0]).toMatchObject({
      level: 'error',
      alert: 'outbox_event_dead',
      reason: 'attempts_exhausted',
      correlation_id: CORRELATION_ID,
    });
    // Feeds the lp-outbox-dead monitor (ops/vercel/monitors.json).
    expect(metrics.records).toEqual([
      { name: 'outbox.dead', value: 1, attributes: { reason: 'attempts_exhausted' } },
    ]);
  });

  it('logs anomalies at warn with IDs and a code only', () => {
    const { telemetry, logged } = build();

    telemetry.anomaly({
      code: 'event_not_found',
      outboxEventId: OUTBOX_EVENT_ID,
      correlationId: CORRELATION_ID,
    });

    const [line] = logged();
    expect(line).toMatchObject({ level: 'warn', code: 'event_not_found' });
    expect(Object.keys(line ?? {}).sort()).toEqual(
      [
        'code',
        'correlation_id',
        'env',
        'level',
        'message',
        'outbox_event_id',
        'service',
        'time',
      ].sort(),
    );
  });
});
