import { z } from 'zod';

/**
 * Schemas for ops/vercel/*.json (wave 6b). They pin the subset of the Vercel WAF and Monitors
 * formats this project uses, so a typo fails in CI instead of at `vercel firewall publish`.
 * Field names follow the Vercel CLI/REST docs (vercel.com/docs/cli/firewall,
 * vercel.com/docs/alerts/configure-alerts, read 2026-11-04).
 */

const MANAGED_PREFIX = /^lp-[a-z0-9-]+$/;

const condition = z
  .object({
    type: z.enum(['path', 'method', 'header', 'query', 'user_agent', 'geo_country', 'ip_address']),
    op: z.enum(['eq', 'neq', 'pre', 'suf', 'sub', 'inc', 'ninc', 're', 'ex', 'nex']),
    value: z.string().min(1).max(256).optional(),
    key: z.string().min(1).max(128).optional(),
    neg: z.boolean().optional(),
  })
  .strict();

const rateLimit = z
  .object({
    algo: z.enum(['fixed_window', 'token_bucket']),
    window: z.number().int().min(10).max(3600),
    limit: z.number().int().min(1).max(10_000_000),
    keys: z.array(z.enum(['ip', 'ja4'])).min(1),
    action: z.enum(['rate_limit', 'deny', 'challenge', 'log']),
  })
  .strict();

const mitigate = z.discriminatedUnion('action', [
  z.object({ action: z.literal('deny') }).strict(),
  z.object({ action: z.literal('challenge') }).strict(),
  z.object({ action: z.literal('log') }).strict(),
  z.object({ action: z.literal('rate_limit'), rateLimit }).strict(),
]);

export const firewallRuleSchema = z
  .object({
    name: z.string().regex(MANAGED_PREFIX),
    description: z.string().min(1).max(256),
    conditionGroup: z
      .array(z.object({ conditions: z.array(condition).min(1).max(10) }).strict())
      .min(1),
    action: z.object({ mitigate }).strict(),
  })
  .strict();

export const firewallFileSchema = z
  .object({
    $comment: z.string(),
    rules: z.array(firewallRuleSchema).min(1),
  })
  .strict();

const monitorMetric = z
  .object({
    metric: z.string().regex(/^[A-Za-z0-9_.\-/]{1,63}$/),
    aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'p50', 'p95', 'p99']),
    filter: z.string().min(1).max(256).optional(),
  })
  .strict();

export const monitorSchema = z
  .object({
    type: z.literal('custom'),
    name: z.string().regex(MANAGED_PREFIX),
    severity: z.enum(['low', 'medium', 'high']),
    evaluation: z
      .object({
        window: z.string().regex(/^\d+[mh]$/),
        query: z
          .object({
            metrics: z.record(z.string(), monitorMetric),
            outputs: z.array(z.string()).min(1),
          })
          .strict(),
      })
      .strict(),
    trigger: z
      .object({
        type: z.literal('threshold'),
        output: z.string(),
        operator: z.enum(['gt', 'gte', 'lt', 'lte']),
        threshold: z.number(),
      })
      .strict(),
  })
  .strict()
  .refine((m) => m.evaluation.query.outputs.every((o) => o in m.evaluation.query.metrics), {
    message: 'every output must name a metric of the query',
  })
  .refine((m) => m.trigger.output in m.evaluation.query.metrics, {
    message: 'trigger.output must name a metric of the query',
  });

export const monitorsFileSchema = z
  .object({
    $comment: z.string(),
    monitors: z.array(monitorSchema).min(1),
  })
  .strict();

export type FirewallRule = z.infer<typeof firewallRuleSchema>;
export type Monitor = z.infer<typeof monitorSchema>;
