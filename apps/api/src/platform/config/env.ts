import { z } from 'zod';

/**
 * Environment contract (000-overview §6, docs/reference/environment.md), validated at boot.
 * Variables of waves 1–5 are declared now (Onda 0) so parallel waves never touch this file;
 * they stay optional until the wave that wires them makes them required.
 * Never read by the runtime: SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD (CLI/CI only).
 */

const MIN_PEPPER_BYTES = 32;
const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/;
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;

/** Blank values from `.env` templates (`KEY=`) count as "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const httpsUrl = z.url({ protocol: /^https$/ });

/**
 * Wired by Onda 4 (`POST /v1/leads`): mandatory in deployed environments so a preview or production
 * build never boots without its lead-capture dependencies. Development may omit them (route unmounted).
 */
const LEAD_CAPTURE_VARIABLES = [
  'DATABASE_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'TURNSTILE_SECRET_KEY',
  'HASH_PEPPER',
] as const;

/**
 * Wired by Onda 5b (outbox → QStash → Meta CAPI): also mandatory in deployed environments, since a
 * deploy without them would capture leads whose conversions are never delivered.
 */
const TRACKING_VARIABLES = [
  'QSTASH_URL',
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'PUBLIC_API_BASE_URL',
  'DEFAULT_WORKSPACE_ID',
] as const;

const appEnvSchema = z.enum(['development', 'preview', 'production']);
export type AppEnv = z.infer<typeof appEnvSchema>;

const rawEnvSchema = z.object({
  // Wave 0 — platform
  APP_ENV: appEnvSchema,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  // Wave 1/4 — Postgres
  DATABASE_URL: optional(z.string().startsWith('postgres')),
  DATABASE_CA_CERT: optional(z.base64()),
  SUPABASE_URL: optional(httpsUrl),
  SUPABASE_PROJECT_REF: optional(z.string().regex(/^[a-z0-9]{20}$/)),
  // Wave 3 — Upstash Redis, Turnstile, hashing
  UPSTASH_REDIS_REST_URL: optional(httpsUrl),
  UPSTASH_REDIS_REST_TOKEN: optional(z.string().min(1)),
  TURNSTILE_SECRET_KEY: optional(z.string().min(1)),
  HASH_PEPPER: optional(
    z.base64().refine((value) => Buffer.from(value, 'base64').length >= MIN_PEPPER_BYTES, {
      message: `must decode to at least ${MIN_PEPPER_BYTES} bytes`,
    }),
  ),
  // Wave 5 — QStash, Meta CAPI, GA4 MP
  QSTASH_URL: optional(httpsUrl),
  QSTASH_TOKEN: optional(z.string().min(1)),
  QSTASH_CURRENT_SIGNING_KEY: optional(z.string().min(1)),
  QSTASH_NEXT_SIGNING_KEY: optional(z.string().min(1)),
  PUBLIC_API_BASE_URL: optional(z.url({ protocol: /^https?$/ })),
  META_PIXEL_ID: optional(z.string().regex(/^[0-9]{5,20}$/)),
  META_CAPI_ACCESS_TOKEN: optional(z.string().min(1)),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v[0-9]{1,3}\.[0-9]$/)
    .default('v25.0'),
  META_TEST_EVENT_CODE: optional(z.string().regex(/^TEST[0-9A-Za-z]{1,20}$/)),
  /** v1 runs one workspace (ADR-0006): the tenant of the internal outbox routes, never from a request. */
  DEFAULT_WORKSPACE_ID: optional(z.uuid()),
  GA4_MP_ENABLED: z.enum(['true', 'false']).default('false'),
  GA4_MEASUREMENT_ID: optional(z.string().regex(/^G-[A-Z0-9]{4,20}$/)),
  GA4_API_SECRET: optional(z.string().min(1)),
});

export interface Config {
  readonly appEnv: AppEnv;
  readonly logLevel: z.infer<typeof rawEnvSchema>['LOG_LEVEL'];
  readonly corsAllowedOrigins: readonly string[];
  readonly database:
    { readonly url: string; readonly caCertBase64: string | undefined } | undefined;
  readonly supabase: { readonly url: string | undefined; readonly projectRef: string | undefined };
  readonly upstashRedis: { readonly url: string; readonly token: string } | undefined;
  readonly turnstileSecretKey: string | undefined;
  readonly hashPepper: string | undefined;
  readonly qstash:
    | {
        readonly url: string;
        readonly token: string;
        readonly currentSigningKey: string;
        readonly nextSigningKey: string;
      }
    | undefined;
  readonly publicApiBaseUrl: string | undefined;
  readonly defaultWorkspaceId: string | undefined;
  readonly meta: {
    readonly pixelId: string | undefined;
    readonly capiAccessToken: string | undefined;
    readonly graphApiVersion: string;
    readonly testEventCode: string | undefined;
  };
  readonly ga4: {
    readonly enabled: boolean;
    readonly measurementId: string | undefined;
    readonly apiSecret: string | undefined;
  };
}

/** Thrown at boot. The message names variables and rules, never their values. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function parseOrigins(raw: string, appEnv: AppEnv): { origins: string[]; issues: string[] } {
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const issues: string[] = [];
  if (origins.length === 0) {
    issues.push('CORS_ALLOWED_ORIGINS: must list at least one origin');
  }
  origins.forEach((origin, index) => {
    const allowed =
      HTTPS_ORIGIN.test(origin) || (appEnv === 'development' && LOCALHOST_ORIGIN.test(origin));
    if (!allowed) {
      issues.push(
        `CORS_ALLOWED_ORIGINS[${index}]: must be an https origin without path` +
          (appEnv === 'development' ? ' (or http://localhost in development)' : ''),
      );
    }
  });
  return { origins, issues };
}

/** Requires that either all or none of a group of variables is set. */
function checkGroup(
  env: Record<string, unknown>,
  names: readonly string[],
  issues: string[],
): void {
  const present = names.filter((name) => env[name] !== undefined);
  if (present.length > 0 && present.length < names.length) {
    const missing = names.filter((name) => env[name] === undefined);
    issues.push(`${missing.join(', ')}: required together with ${present.join(', ')}`);
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  const issues: string[] = [];

  const { origins, issues: originIssues } = parseOrigins(e.CORS_ALLOWED_ORIGINS, e.APP_ENV);
  issues.push(...originIssues);
  checkGroup(e, ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], issues);
  checkGroup(
    e,
    ['QSTASH_URL', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'],
    issues,
  );
  if (e.APP_ENV !== 'development') {
    for (const name of [...LEAD_CAPTURE_VARIABLES, ...TRACKING_VARIABLES]) {
      if (e[name] === undefined) {
        issues.push(`${name}: required in ${e.APP_ENV}`);
      }
    }
  }
  checkGroup(e, ['META_PIXEL_ID', 'META_CAPI_ACCESS_TOKEN'], issues);
  if (
    e.GA4_MP_ENABLED === 'true' &&
    (e.GA4_MEASUREMENT_ID === undefined || e.GA4_API_SECRET === undefined)
  ) {
    issues.push('GA4_MP_ENABLED: requires GA4_MEASUREMENT_ID and GA4_API_SECRET');
  }
  if (e.APP_ENV === 'production' && e.META_TEST_EVENT_CODE !== undefined) {
    issues.push('META_TEST_EVENT_CODE: must not be set in production');
  }
  if (e.APP_ENV !== 'development' && e.PUBLIC_API_BASE_URL?.startsWith('http:') === true) {
    issues.push('PUBLIC_API_BASE_URL: must use https outside development');
  }
  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    appEnv: e.APP_ENV,
    logLevel: e.LOG_LEVEL,
    corsAllowedOrigins: origins,
    database:
      e.DATABASE_URL === undefined
        ? undefined
        : { url: e.DATABASE_URL, caCertBase64: e.DATABASE_CA_CERT },
    supabase: { url: e.SUPABASE_URL, projectRef: e.SUPABASE_PROJECT_REF },
    upstashRedis:
      e.UPSTASH_REDIS_REST_URL !== undefined && e.UPSTASH_REDIS_REST_TOKEN !== undefined
        ? { url: e.UPSTASH_REDIS_REST_URL, token: e.UPSTASH_REDIS_REST_TOKEN }
        : undefined,
    turnstileSecretKey: e.TURNSTILE_SECRET_KEY,
    hashPepper: e.HASH_PEPPER,
    qstash:
      e.QSTASH_URL !== undefined &&
      e.QSTASH_TOKEN !== undefined &&
      e.QSTASH_CURRENT_SIGNING_KEY !== undefined &&
      e.QSTASH_NEXT_SIGNING_KEY !== undefined
        ? {
            url: e.QSTASH_URL,
            token: e.QSTASH_TOKEN,
            currentSigningKey: e.QSTASH_CURRENT_SIGNING_KEY,
            nextSigningKey: e.QSTASH_NEXT_SIGNING_KEY,
          }
        : undefined,
    publicApiBaseUrl: e.PUBLIC_API_BASE_URL,
    defaultWorkspaceId: e.DEFAULT_WORKSPACE_ID,
    meta: {
      pixelId: e.META_PIXEL_ID,
      capiAccessToken: e.META_CAPI_ACCESS_TOKEN,
      graphApiVersion: e.META_GRAPH_API_VERSION,
      testEventCode: e.META_TEST_EVENT_CODE,
    },
    ga4: {
      enabled: e.GA4_MP_ENABLED === 'true',
      measurementId: e.GA4_MEASUREMENT_ID,
      apiSecret: e.GA4_API_SECRET, // gitleaks:allow — maps the variable, never a literal value
    },
  };
}
