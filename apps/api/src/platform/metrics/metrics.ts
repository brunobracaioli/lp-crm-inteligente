import { metric } from '@vercel/functions';

/** Metric names from 000-overview §5.3. Adding a name is a reviewed change, not a free string. */
export type MetricName =
  | 'lead_capture.requests'
  | 'lead_capture.latency_ms'
  | 'antibot.failures'
  | 'ratelimit.blocked'
  | 'ratelimit.fail_open'
  | 'outbox.lag_s'
  | 'delivery.result'
  | 'auth.qstash_signature_invalid'
  | 'auth.staff_rejected'
  | 'ai.cost_usd';

/** Attribute values must be low-cardinality codes (never IDs, never PII). */
export type MetricAttributes = Readonly<Record<string, string>>;

export interface Metrics {
  record(name: MetricName, value: number, attributes?: MetricAttributes): void;
}

/** Vercel Custom Metrics. Outside a Vercel Function `metric()` is a no-op. */
export const vercelMetrics: Metrics = {
  record(name, value, attributes) {
    metric(name, value, attributes === undefined ? undefined : { ...attributes });
  },
};

/** In-memory recorder for tests. */
export function createRecordingMetrics(): Metrics & {
  readonly records: { name: MetricName; value: number; attributes: MetricAttributes | undefined }[];
} {
  const records: { name: MetricName; value: number; attributes: MetricAttributes | undefined }[] =
    [];
  return {
    records,
    record(name, value, attributes) {
      records.push({ name, value, attributes });
    },
  };
}
