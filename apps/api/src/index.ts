import { createApp } from '#/app.ts';
import { composeLeadCapture } from '#/composition/lead-capture.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { vercelMetrics } from '#/platform/metrics/metrics.ts';
import { registerTelemetry } from '#/platform/otel/register.ts';
import type { TriggerOutboxDispatch } from '#/modules/tracking/public-api.ts';

// Composition root (Vercel entrypoint). Fails fast on invalid configuration.
const config = loadConfig(process.env);
registerTelemetry();
const logger = createLogger({ level: config.logLevel, appEnv: config.appEnv });

/**
 * Onda 4 leaves `lead.captured` events pending in tracking.outbox_events; Onda 5b replaces this with
 * the QStash publish (`waitUntil`) and the sweeper delivers anything left behind.
 */
const deferOutboxDispatch: TriggerOutboxDispatch = () => undefined;

const app = createApp({
  config,
  logger,
  routes: composeLeadCapture({
    config,
    logger,
    metrics: vercelMetrics,
    triggerOutboxDispatch: deferOutboxDispatch,
  }),
});

export default app;
