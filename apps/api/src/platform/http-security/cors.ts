import { cors } from 'hono/cors';

const PREFLIGHT_MAX_AGE_SECONDS = 600;

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
