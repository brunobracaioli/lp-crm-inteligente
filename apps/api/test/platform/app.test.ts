import { Writable } from 'node:stream';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '#/app.ts';
import { loadConfig } from '#/platform/config/env.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import { MAX_BODY_BYTES } from '#/platform/http-security/body-limit.ts';
import { SECURITY_HEADERS } from '#/platform/http-security/security-headers.ts';
import { createLogger } from '#/platform/logger/logger.ts';

const ALLOWED_ORIGIN = 'https://www.example.com.br';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTERNAL_DETAIL = 'relation "crm.leads" violates constraint at /srv/app/db.ts:42';

function buildApp() {
  const logLines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const testRoutes = new Hono<AppEnv>()
    .get('/test/boom', () => {
      throw new Error(INTERNAL_DETAIL);
    })
    .post('/test/echo', async (c) => c.json({ size: (await c.req.text()).length }));

  const app = createApp({
    config: loadConfig({ APP_ENV: 'development', CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN }),
    logger: createLogger({ level: 'info', appEnv: 'test', destination }),
    routes: [testRoutes],
  });
  return { app, logLines };
}

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

describe('GET /v1/health', () => {
  it('returns 200 {status: ok} with the 8 security headers and a correlation id', async () => {
    const { app } = buildApp();

    const response = await app.request('/v1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(Object.keys(SECURITY_HEADERS)).toHaveLength(8);
    expectSecurityHeaders(response);
    expect(response.headers.get('X-Request-Id')).toMatch(UUID);
  });

  it('echoes a valid client X-Request-Id and replaces an invalid one', async () => {
    const { app } = buildApp();
    const clientId = '6a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

    const echoed = await app.request('/v1/health', { headers: { 'X-Request-Id': clientId } });
    const replaced = await app.request('/v1/health', {
      headers: { 'X-Request-Id': '<script>alert(1)</script>' },
    });

    expect(echoed.headers.get('X-Request-Id')).toBe(clientId);
    expect(replaced.headers.get('X-Request-Id')).toMatch(UUID);
  });
});

describe('error responses', () => {
  it('unknown route → 404 problem+json with correlation_id and security headers', async () => {
    const { app } = buildApp();

    const response = await app.request('/v1/does-not-exist');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('application/problem+json');
    expect(body).toMatchObject({ status: 404, code: 'not_found', title: 'Not found' });
    expect(body.correlation_id).toBe(response.headers.get('X-Request-Id'));
    expect(body.type).toBe('http://localhost/problems/not_found');
    expectSecurityHeaders(response);
  });

  it('thrown error → 500 internal_error without stack or internal detail', async () => {
    const { app, logLines } = buildApp();

    const response = await app.request('/test/boom');
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ code: 'internal_error', status: 500 });
    expect(text).not.toContain('crm.leads');
    expect(text).not.toContain('db.ts');
    expect(text).not.toMatch(/\bat\s.+:\d+/);
    expectSecurityHeaders(response);
    // the detail is logged server-side for operators
    expect(logLines.join('')).toContain('unhandled error');
  });

  it('body above 16 KB → 413 payload_too_large', async () => {
    const { app } = buildApp();

    const response = await app.request('/test/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'payload_too_large' });
    expectSecurityHeaders(response);
  });
});

describe('CORS', () => {
  it('preflight from an allowed origin gets ACAO without credentials and security headers', async () => {
    const { app } = buildApp();

    const response = await app.request('/v1/health', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expectSecurityHeaders(response);
  });

  it('preflight from an unknown origin gets no Access-Control-Allow-Origin', async () => {
    const { app } = buildApp();

    const response = await app.request('/v1/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expectSecurityHeaders(response);
  });
});
