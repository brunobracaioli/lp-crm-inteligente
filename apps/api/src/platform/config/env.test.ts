import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '#/platform/config/env.ts';

const BASE = {
  APP_ENV: 'development',
  CORS_ALLOWED_ORIGINS: 'http://localhost:4321, https://www.example.com.br',
} as const;

function captureConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a minimal development environment with defaults', () => {
    const config = loadConfig(BASE);

    expect(config.appEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.corsAllowedOrigins).toEqual([
      'http://localhost:4321',
      'https://www.example.com.br',
    ]);
    expect(config.meta.graphApiVersion).toBe('v25.0');
    expect(config.database).toBeUndefined();
  });

  it('treats blank template values as unset', () => {
    const config = loadConfig({ ...BASE, DATABASE_URL: '', HASH_PEPPER: '' });
    expect(config.database).toBeUndefined();
    expect(config.hashPepper).toBeUndefined();
  });

  it('fails naming the variable but never echoing its value', () => {
    const secretLooking = 'not-a-valid-env-value-s3cr3t';
    const error = captureConfigError({ ...BASE, APP_ENV: secretLooking });

    expect(error.message).toContain('APP_ENV');
    expect(error.message).not.toContain(secretLooking);
  });

  it('rejects a short HASH_PEPPER without leaking it', () => {
    const shortPepper = Buffer.from('too-short').toString('base64');
    const error = captureConfigError({ ...BASE, HASH_PEPPER: shortPepper });

    expect(error.message).toContain('HASH_PEPPER');
    expect(error.message).not.toContain(shortPepper);
  });

  it('requires a non-empty origin list', () => {
    expect(captureConfigError({ ...BASE, CORS_ALLOWED_ORIGINS: undefined }).message).toContain(
      'CORS_ALLOWED_ORIGINS',
    );
    expect(captureConfigError({ ...BASE, CORS_ALLOWED_ORIGINS: ' , ' }).message).toContain(
      'at least one origin',
    );
  });

  it('accepts http://localhost only in development', () => {
    const error = captureConfigError({
      APP_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'http://localhost:4321',
    });
    expect(error.message).toContain('CORS_ALLOWED_ORIGINS[0]');
  });

  it('rejects origins with a path or wildcard', () => {
    expect(() => loadConfig({ ...BASE, CORS_ALLOWED_ORIGINS: 'https://example.com/path' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...BASE, CORS_ALLOWED_ORIGINS: '*' })).toThrow(ConfigError);
  });

  it('defaults CRM_WEB_ORIGINS to no origin and parses a list when set', () => {
    expect(loadConfig(BASE).crmWebOrigins).toEqual([]);
    expect(loadConfig({ ...BASE, CRM_WEB_ORIGINS: '' }).crmWebOrigins).toEqual([]);
    expect(
      loadConfig({
        ...BASE,
        CRM_WEB_ORIGINS: 'https://crm.example.com.br, http://localhost:5173',
      }).crmWebOrigins,
    ).toEqual(['https://crm.example.com.br', 'http://localhost:5173']);
  });

  it('rejects invalid CRM_WEB_ORIGINS naming the variable only', () => {
    const error = captureConfigError({
      ...BASE,
      APP_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://www.example.com.br',
      CRM_WEB_ORIGINS: 'http://localhost:5173, https://crm.example.com.br/app, *',
    });
    expect(error.message).toContain('CRM_WEB_ORIGINS[0]');
    expect(error.message).toContain('CRM_WEB_ORIGINS[1]');
    expect(error.message).toContain('CRM_WEB_ORIGINS[2]');
    expect(error.message).not.toContain('crm.example.com.br/app');
  });

  it('requires grouped variables together', () => {
    const error = captureConfigError({ ...BASE, UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' });
    expect(error.message).toContain('UPSTASH_REDIS_REST_TOKEN');
  });

  it('requires the lead-capture variables outside development, naming each one', () => {
    // act
    const error = captureConfigError({
      ...BASE,
      APP_ENV: 'preview',
      CORS_ALLOWED_ORIGINS: 'https://lp.example.com.br',
    });
    // assert
    expect(error.issues).toEqual([
      'DATABASE_URL: required in preview',
      'UPSTASH_REDIS_REST_URL: required in preview',
      'UPSTASH_REDIS_REST_TOKEN: required in preview',
      'TURNSTILE_SECRET_KEY: required in preview',
      'HASH_PEPPER: required in preview',
      'QSTASH_URL: required in preview',
      'QSTASH_TOKEN: required in preview',
      'QSTASH_CURRENT_SIGNING_KEY: required in preview',
      'QSTASH_NEXT_SIGNING_KEY: required in preview',
      'PUBLIC_API_BASE_URL: required in preview',
      'DEFAULT_WORKSPACE_ID: required in preview',
    ]);
  });

  it('keeps GA4 Measurement Protocol off unless explicitly enabled with its credentials', () => {
    // act
    const off = loadConfig(BASE);
    const misconfigured = captureConfigError({ ...BASE, GA4_MP_ENABLED: 'true' });
    // assert
    expect(off.ga4.enabled).toBe(false);
    expect(misconfigured.issues).toEqual([
      'GA4_MP_ENABLED: requires GA4_MEASUREMENT_ID and GA4_API_SECRET',
    ]);
  });

  it('forbids META_TEST_EVENT_CODE in production', () => {
    const error = captureConfigError({
      APP_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://www.example.com.br',
      META_TEST_EVENT_CODE: 'TEST12345',
    });
    expect(error.message).toContain('META_TEST_EVENT_CODE');
  });

  it('builds grouped sections when complete', () => {
    const config = loadConfig({
      ...BASE,
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      DATABASE_URL: 'postgresql://lp_api.ref:pw@host:6543/postgres?sslmode=verify-full',
    });
    expect(config.upstashRedis).toEqual({ url: 'https://x.upstash.io', token: 'token' });
    expect(config.database?.url).toContain('sslmode=verify-full');
  });
});
