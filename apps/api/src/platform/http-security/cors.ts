import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '#/platform/http/app-env.ts';

const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** Route group of the staff API: it gets its own origin allowlist (threat model crm-staff-auth C45, G8). */
export const CRM_PATH_PREFIX = '/v1/crm';

/**
 * CORS allowlist without credentials. Unknown origins get no Access-Control-Allow-Origin header.
 * CORS protects browsers only; the Origin check per form (wave 4) is the server-side barrier.
 */
export function corsAllowlist(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: false,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  });
}

/**
 * CORS for `/v1/crm/*`: only the CRM web origins, `Authorization` allowed in the preflight, and the
 * export headers readable by the browser. Never `Allow-Credentials`: the token travels in a header,
 * not in a cookie, so CORS is not the defense here, but a LP origin must still be unable to read
 * the response in a victim's browser. An empty allowlist accepts no browser origin at all.
 */
export function corsCrmWeb(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposeHeaders: [
      'X-Request-Id',
      'Retry-After',
      'Content-Disposition',
      'X-Export-Row-Count',
      'X-Export-Truncated',
    ],
    credentials: false,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  });
}

export function isCrmPath(path: string): boolean {
  return path === CRM_PATH_PREFIX || path.startsWith(`${CRM_PATH_PREFIX}/`);
}

export interface CorsGroups {
  /** Origins of the landing pages (every route outside `/v1/crm`). */
  readonly publicOrigins: readonly string[];
  /** Origins of the CRM web app (`/v1/crm/*` only). */
  readonly crmWebOrigins: readonly string[];
}

/** Dispatches each request to exactly one CORS policy, so a LP origin never gets CRM headers or vice versa. */
export function corsByRouteGroup(groups: CorsGroups) {
  const publicCors = corsAllowlist(groups.publicOrigins);
  const crmCors = corsCrmWeb(groups.crmWebOrigins);
  return createMiddleware<AppEnv>((c, next) =>
    isCrmPath(c.req.path) ? crmCors(c, next) : publicCors(c, next),
  );
}
