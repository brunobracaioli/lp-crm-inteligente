import { describe, expect, it } from 'vitest';
import { composeLeadCapture } from '#/composition/lead-capture.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';

const DEV_ENV = {
  APP_ENV: 'development',
  CORS_ALLOWED_ORIGINS: 'http://localhost:4321',
} as const;
// Placeholders only: the clients are lazy, so composing never opens a connection.
const LEAD_CAPTURE_ENV = {
  DATABASE_URL: 'postgresql://lp_api:placeholder@127.0.0.1:1/postgres',
  UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'placeholder',
  TURNSTILE_SECRET_KEY: 'placeholder',
  HASH_PEPPER: Buffer.alloc(32, 7).toString('base64'),
} as const;

const compose = (env: Record<string, string>) =>
  composeLeadCapture({
    config: loadConfig(env),
    logger: createLogger({ level: 'silent', appEnv: 'development' }),
    metrics: createRecordingMetrics(),
    triggerOutboxDispatch: () => undefined,
  });

describe('composeLeadCapture', () => {
  it('mounts no route in development when the lead-capture dependencies are missing', () => {
    // act
    const routes = compose(DEV_ENV);
    // assert
    expect(routes).toEqual([]);
  });

  it('mounts POST /v1/leads when every dependency is configured', () => {
    // act
    const routes = compose({ ...DEV_ENV, ...LEAD_CAPTURE_ENV });
    // assert
    expect(routes).toHaveLength(1);
    expect(routes[0]?.routes.map((route) => `${route.method} ${route.path}`)).toContain(
      'POST /v1/leads',
    );
  });
});
