import { Hono } from 'hono';
import type { Config } from '#/platform/config/env.ts';
import { correlation } from '#/platform/correlation/correlation.ts';
import { errorHandler, notFoundHandler } from '#/platform/errors/error-handler.ts';
import { healthRoutes } from '#/platform/health/http.ts';
import type { StaffEnv } from '#/platform/auth/staff.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import { bodyLimit16k } from '#/platform/http-security/body-limit.ts';
import { corsByRouteGroup } from '#/platform/http-security/cors.ts';
import { securityHeaders } from '#/platform/http-security/security-headers.ts';
import type { Logger } from '#/platform/logger/logger.ts';

export interface AppDependencies {
  readonly config: Config;
  readonly logger: Logger;
  /**
   * Extra route groups (tests, later waves). Mounted after the platform middlewares. Staff route groups
   * (`Hono<StaffEnv>`) authenticate themselves through `StaffGuards`; the app adds no auth of its own.
   */
  readonly routes?: readonly (Hono<AppEnv> | Hono<StaffEnv>)[];
}

/**
 * Builds the Hono app. Middleware order is part of the security contract (000-overview §5.1):
 * security headers (outermost, so errors get them too) → correlation id → CORS (LP allowlist, or the
 * CRM web allowlist under `/v1/crm`) → body limit → routes.
 */
export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders);
  app.use('*', correlation(deps.logger));
  app.use(
    '*',
    corsByRouteGroup({
      publicOrigins: deps.config.corsAllowedOrigins,
      crmWebOrigins: deps.config.crmWebOrigins,
    }),
  );
  app.use('*', bodyLimit16k);

  app.route('/', healthRoutes);
  for (const routes of deps.routes ?? []) {
    // A staff group needs `staff` in its context, which its own `authenticate` guard sets before any
    // handler runs; the app-level middlewares above only touch the AppEnv part both groups share.
    app.route('/', routes as Hono<AppEnv>);
  }

  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}
