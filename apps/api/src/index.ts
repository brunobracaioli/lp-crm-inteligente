import { waitUntil } from '@vercel/functions';
import { createApp } from '#/app.ts';
import { composeApiRoutes } from '#/composition/api.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { vercelMetrics } from '#/platform/metrics/metrics.ts';
import { registerTelemetry } from '#/platform/otel/register.ts';

// Composition root (Vercel entrypoint). Fails fast on invalid configuration.
const config = loadConfig(process.env);
registerTelemetry();
const logger = createLogger({ level: config.logLevel, appEnv: config.appEnv });

const app = createApp({
  config,
  logger,
  routes: composeApiRoutes({
    config,
    logger,
    metrics: vercelMetrics,
    runInBackground: waitUntil,
  }),
});

export default app;
