import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '#/app.ts';
import { loadConfig } from '#/platform/config/env.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { isCrmPath } from './cors.ts';

const LP_ORIGIN = 'https://www.example.com.br';
const CRM_ORIGIN = 'https://crm.example.com.br';

function build(crmWebOrigins: string | null = CRM_ORIGIN) {
  const routes = new Hono<AppEnv>()
    .get('/v1/crm/ping', (c) => c.json({ ok: true }))
    .get('/v1/crm', (c) => c.json({ ok: true }))
    .get('/v1/other', (c) => c.json({ ok: true }));
  return createApp({
    config: loadConfig({
      APP_ENV: 'development',
      CORS_ALLOWED_ORIGINS: LP_ORIGIN,
      ...(crmWebOrigins === null ? {} : { CRM_WEB_ORIGINS: crmWebOrigins }),
    }),
    logger: createLogger({ level: 'silent', appEnv: 'test' }),
    routes: [routes],
  });
}

function preflight(app: ReturnType<typeof build>, path: string, origin: string, headers: string) {
  return app.request(path, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': headers,
    },
  });
}

describe('isCrmPath', () => {
  it.each(['/v1/crm', '/v1/crm/', '/v1/crm/me', '/v1/crm/leads/export.csv'])(
    '%s is CRM',
    (path) => {
      expect(isCrmPath(path)).toBe(true);
    },
  );
  it.each(['/v1/crmx', '/v1/leads', '/v1/health', '/crm', '/v1/other/v1/crm'])(
    '%s is not CRM',
    (path) => {
      expect(isCrmPath(path)).toBe(false);
    },
  );
});

describe('CORS for the CRM route group (ST-36, C45)', () => {
  it('answers the CRM web preflight with Authorization allowed and no credentials', async () => {
    const response = await preflight(
      build(),
      '/v1/crm/leads',
      CRM_ORIGIN,
      'authorization,content-type',
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(CRM_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization,Content-Type,Idempotency-Key,X-Request-Id',
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PATCH,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(response.headers.get('Vary')).toContain('Origin');
  });

  it('refuses the preflight of a landing page origin on /v1/crm/*', async () => {
    const response = await preflight(build(), '/v1/crm/leads', LP_ORIGIN, 'authorization');

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not expose CRM responses to a landing page origin', async () => {
    const response = await build().request('/v1/crm/ping', { headers: { Origin: LP_ORIGIN } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('exposes the export headers to the CRM web origin', async () => {
    const response = await build().request('/v1/crm/ping', { headers: { Origin: CRM_ORIGIN } });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(CRM_ORIGIN);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Export-Truncated');
  });

  it('accepts no browser origin at all when CRM_WEB_ORIGINS is not set', async () => {
    const app = build(null);
    const crm = await preflight(app, '/v1/crm/leads', CRM_ORIGIN, 'authorization');
    const lp = await preflight(app, '/v1/crm/leads', LP_ORIGIN, 'authorization');

    expect(crm.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(lp.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('treats the bare /v1/crm path like the group', async () => {
    const response = await build().request('/v1/crm', { headers: { Origin: LP_ORIGIN } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('CORS outside the CRM route group keeps the landing page allowlist', () => {
  it('allows the landing page origin and not the CRM web origin', async () => {
    const app = build();
    const lp = await preflight(app, '/v1/other', LP_ORIGIN, 'content-type');
    const crm = await preflight(app, '/v1/other', CRM_ORIGIN, 'content-type');

    expect(lp.headers.get('Access-Control-Allow-Origin')).toBe(LP_ORIGIN);
    expect(lp.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type,Idempotency-Key,X-Request-Id',
    );
    expect(lp.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,OPTIONS');
    expect(crm.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('never allows Authorization from a landing page origin', async () => {
    const response = await preflight(build(), '/v1/other', LP_ORIGIN, 'authorization');

    expect(response.headers.get('Access-Control-Allow-Headers')).not.toContain('Authorization');
  });
});
