import { Redis } from '@upstash/redis';
import type { Hono } from 'hono';
import type { Config } from '#/platform/config/env.ts';
import { createHmacHasher } from '#/platform/crypto/hashing.ts';
import {
  createPostgresAuditLogWriter,
  createPostgresUnitOfWork,
  type Sql,
} from '#/platform/db/index.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import { systemClock } from '#/platform/runtime/system-clock.ts';
import type { IdGenerator } from '#/shared/ids.ts';
import { createPostgresIcpSettingsProvider } from '#/modules/crm/infrastructure/postgres-icp-settings-provider.ts';
import { createPostgresLeadActivityRepository } from '#/modules/crm/infrastructure/postgres-lead-activity-repository.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import { createRegisterInboundLead } from '#/modules/crm/public-api.ts';
import { createSubmitLead } from '#/modules/lead-capture/application/submit-lead.ts';
import { createPostgresConsentRepository } from '#/modules/lead-capture/infrastructure/postgres-consent-repository.ts';
import { createPostgresFormLookup } from '#/modules/lead-capture/infrastructure/postgres-form-lookup.ts';
import { createPostgresSubmissionRepository } from '#/modules/lead-capture/infrastructure/postgres-submission-repository.ts';
import { createTurnstileVerifier } from '#/modules/lead-capture/infrastructure/turnstile-verifier.ts';
import { createUpstashIdempotencyStore } from '#/modules/lead-capture/infrastructure/upstash-idempotency-store.ts';
import {
  createUpstashRateLimitWindows,
  createUpstashRateLimiter,
} from '#/modules/lead-capture/infrastructure/upstash-rate-limiter.ts';
import { createLeadCaptureRoutes } from '#/modules/lead-capture/presentation/http.ts';
import { createPostgresOutboxWriter } from '#/modules/tracking/infrastructure/postgres-outbox-writer.ts';
import type { TriggerOutboxDispatch } from '#/modules/tracking/public-api.ts';

/**
 * `in_progress` idempotency marker TTL. Longer than the function `maxDuration` (10 s, vercel.json)
 * so a live request is never overtaken, short enough that a crashed one does not block the client's
 * retry for 24 h (Onda 3 review). `complete` still stores the response for the full 24 h.
 */
const IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS = 60;
/** One quick retry on network errors; adapters already cap every Redis call at 1 s. */
const REDIS_RETRY = { retries: 1, backoff: () => REDIS_RETRY_BACKOFF_MS } as const;
const REDIS_RETRY_BACKOFF_MS = 50;

export interface LeadCaptureCompositionInput {
  readonly config: Config;
  /** Shared Postgres client; null when `DATABASE_URL` is not configured (development only). */
  readonly sql: Sql | null;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Post-commit publish of the outbox event (Onda 5b); until then the sweeper picks it up. */
  readonly triggerOutboxDispatch: TriggerOutboxDispatch;
}

interface LeadCaptureSecrets {
  readonly upstashRedis: NonNullable<Config['upstashRedis']>;
  readonly turnstileSecretKey: string;
  readonly hashPepper: string;
}

/** Null when a lead-capture dependency is not configured (allowed in development only, see env.ts). */
function leadCaptureSecrets(config: Config): LeadCaptureSecrets | null {
  const { upstashRedis, turnstileSecretKey, hashPepper } = config;
  if (upstashRedis === undefined || turnstileSecretKey === undefined || hashPepper === undefined) {
    return null;
  }
  return { upstashRedis, turnstileSecretKey, hashPepper };
}

/**
 * Wires `POST /v1/leads` (Onda 4): Postgres adapters behind one unit of work, Upstash limiter and
 * idempotency store, Turnstile, and the crm use case through its public API. Returns no routes when
 * the dependencies are missing in development, so `vercel dev` still boots for the health probe.
 */
export function composeLeadCapture(input: LeadCaptureCompositionInput): readonly Hono<AppEnv>[] {
  const { config, logger, metrics, sql, ids } = input;
  const secrets = leadCaptureSecrets(config);
  if (secrets === null || sql === null) {
    logger.warn({ route: 'POST /v1/leads' }, 'lead capture not configured; route not mounted');
    return [];
  }

  const redis = new Redis({
    url: secrets.upstashRedis.url,
    token: secrets.upstashRedis.token,
    retry: REDIS_RETRY,
  });
  const hmac = createHmacHasher(secrets.hashPepper);

  const registerInboundLead = createRegisterInboundLead({
    leads: createPostgresLeadRepository(),
    activities: createPostgresLeadActivityRepository(),
    icp: createPostgresIcpSettingsProvider(),
    ids,
  });

  const submitLead = createSubmitLead({
    forms: createPostgresFormLookup(sql),
    rateLimiter: createUpstashRateLimiter({
      windows: createUpstashRateLimitWindows(redis),
      blocks: redis,
      hmac,
      clock: systemClock,
      logger,
      metrics,
    }),
    antiBot: createTurnstileVerifier({
      secretKey: secrets.turnstileSecretKey,
      clock: systemClock,
      logger,
      metrics,
    }),
    idempotency: createUpstashIdempotencyStore({
      redis,
      logger,
      inProgressTtlSeconds: IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS,
    }),
    unitOfWork: createPostgresUnitOfWork(sql),
    submissions: createPostgresSubmissionRepository(),
    consents: createPostgresConsentRepository(),
    outbox: createPostgresOutboxWriter(),
    audit: createPostgresAuditLogWriter(),
    registerInboundLead,
    triggerOutboxDispatch: input.triggerOutboxDispatch,
    clock: systemClock,
    ids,
    hmac,
  });

  return [
    createLeadCaptureRoutes({
      submitLead,
      metrics,
      clientIp: { trustVercelProxy: config.appEnv !== 'development' },
    }),
  ];
}
