import { describe, expect, it } from 'vitest';
import { composeApiRoutes } from '#/composition/api.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';

const DEV_ENV = {
  APP_ENV: 'development',
  CORS_ALLOWED_ORIGINS: 'http://localhost:4321',
} as const;
// Placeholders only: every client is lazy, so composing never opens a connection or calls out.
const LEAD_CAPTURE_ENV = {
  DATABASE_URL: 'postgresql://lp_api:placeholder@127.0.0.1:1/postgres',
  UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'placeholder',
  TURNSTILE_SECRET_KEY: 'placeholder',
  HASH_PEPPER: Buffer.alloc(32, 7).toString('base64'),
} as const;
const TRACKING_ENV = {
  QSTASH_URL: 'https://qstash.invalid',
  QSTASH_TOKEN: 'placeholder',
  QSTASH_CURRENT_SIGNING_KEY: 'placeholder-current',
  QSTASH_NEXT_SIGNING_KEY: 'placeholder-next',
  PUBLIC_API_BASE_URL: 'http://localhost:3000',
  DEFAULT_WORKSPACE_ID: '01920000-0000-7000-8000-000000000001',
} as const;

const CRM_ENV = { SUPABASE_URL: 'https://project.supabase.invalid' } as const;

function mountedRoutes(env: Record<string, string>): string[] {
  const groups = composeApiRoutes({
    config: loadConfig(env),
    logger: createLogger({ level: 'silent', appEnv: 'development' }),
    metrics: createRecordingMetrics(),
    runInBackground: () => undefined,
  });
  return groups.flatMap((group) => group.routes.map((route) => `${route.method} ${route.path}`));
}

describe('composeApiRoutes', () => {
  it('mounts nothing in development when no dependency is configured', () => {
    // act / assert
    expect(mountedRoutes(DEV_ENV)).toEqual([]);
  });

  it('mounts only POST /v1/leads when tracking is not configured', () => {
    // act
    const routes = mountedRoutes({ ...DEV_ENV, ...LEAD_CAPTURE_ENV });
    // assert
    expect(routes).toContain('POST /v1/leads');
    expect(routes.some((route) => route.includes('/internal/'))).toBe(false);
  });

  it('mounts the lead route and both internal outbox routes when everything is configured', () => {
    // act
    const routes = mountedRoutes({ ...DEV_ENV, ...LEAD_CAPTURE_ENV, ...TRACKING_ENV });
    // assert
    expect(routes).toEqual(
      expect.arrayContaining([
        'POST /v1/leads',
        'POST /internal/v1/outbox/dispatch',
        'POST /internal/v1/outbox/sweep',
      ]),
    );
  });

  it('mounts no CRM route unless the identity provider is configured (fail closed)', () => {
    // act
    const routes = mountedRoutes({ ...DEV_ENV, ...LEAD_CAPTURE_ENV, ...TRACKING_ENV });
    // assert
    expect(routes.some((route) => route.includes('/v1/crm/'))).toBe(false);
  });

  it('mounts the CRM staff and read routes when the identity provider is configured', () => {
    // act
    const routes = mountedRoutes({ ...DEV_ENV, ...LEAD_CAPTURE_ENV, ...CRM_ENV });
    // assert
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /v1/crm/me',
        'GET /v1/crm/members',
        'GET /v1/crm/leads',
        'POST /v1/crm/leads/search',
      ]),
    );
  });
});
