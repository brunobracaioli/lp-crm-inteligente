import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '#/platform/http/app-env.ts';

/** Baseline headers on every API response, including errors and preflight (000-overview §5.1). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Cache-Control': 'no-store',
};

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    c.res.headers.set(name, value);
  }
});
