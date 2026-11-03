import { createApp } from '#/app.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { registerTelemetry } from '#/platform/otel/register.ts';

// Composition root (Vercel entrypoint). Fails fast on invalid configuration.
const config = loadConfig(process.env);
registerTelemetry();
const logger = createLogger({ level: config.logLevel, appEnv: config.appEnv });

const app = createApp({ config, logger });

export default app;
