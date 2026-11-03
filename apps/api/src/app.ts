import { Hono } from 'hono';
import type { Config } from '#/platform/config/env.ts';
import { correlation } from '#/platform/correlation/correlation.ts';
import { errorHandler, notFoundHandler } from '#/platform/errors/error-handler.ts';
import { healthRoutes } from '#/platform/health/http.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import { bodyLimit16k } from '#/platform/http-security/body-limit.ts';
import { corsAllowlist } from '#/platform/http-security/cors.ts';
import { securityHeaders } from '#/platform/http-security/security-headers.ts';
import type { Logger } from '#/platform/logger/logger.ts';

export interface AppDependencies {
  readonly config: Config;
  readonly logger: Logger;
  /** Extra route groups (tests, later waves). Mounted after the platform middlewares. */
  readonly routes?: readonly Hono<AppEnv>[];
}

/**
 * Builds the Hono app. Middleware order is part of the security contract (000-overview §5.1):
 * security headers (outermost, so errors get them too) → correlation id → CORS → body limit → routes.
 */
export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders);
  app.use('*', correlation(deps.logger));
  app.use('*', corsAllowlist(deps.config.corsAllowedOrigins));
  app.use('*', bodyLimit16k);

  app.route('/', healthRoutes);
  for (const routes of deps.routes ?? []) {
    app.route('/', routes);
  }

  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}
