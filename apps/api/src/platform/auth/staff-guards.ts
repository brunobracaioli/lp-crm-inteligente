import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  InvalidAccessTokenError,
  MAX_TOKEN_LENGTH,
  SigningKeysUnavailableError,
  type AccessTokenVerifier,
} from '#/platform/auth/access-token-verifier.ts';
import type { StaffMembershipResolver } from '#/platform/auth/staff-membership.ts';
import type { StaffLimitScope, StaffRateLimiter } from '#/platform/auth/staff-rate-limiter.ts';
import type {
  RateLimitFailMode,
  StaffEnv,
  StaffGuards,
  StaffPrincipal,
  StaffRateBucket,
} from '#/platform/auth/staff.ts';
import type { HmacHasher } from '#/platform/crypto/hashing.ts';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { HttpProblem } from '#/platform/errors/problem.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import { rateLimitSubject, resolveClientIp } from '#/platform/net/client-ip.ts';
import type { UserId } from '#/shared/ids.ts';

/**
 * `StaffGuards` for the composition root. Evaluation order (contract `staffBearer`):
 * rate limit by IP → token verification (401) → membership (403) → [route] rate limit by user (429/503) →
 * role (403) → AAL2 (403) → resource. The first two are inside `authenticate`; the rest are route middleware.
 */

export interface StaffGuardsDependencies {
  readonly verifier: AccessTokenVerifier;
  readonly memberships: StaffMembershipResolver;
  readonly limiter: StaffRateLimiter;
  readonly metrics: Metrics;
  /** HMAC-SHA256 with `HASH_PEPPER`: an IP never reaches a Redis key in clear. */
  readonly hmac: HmacHasher;
  /** True behind the Vercel proxy (preview/production). Elsewhere `x-real-ip` is client-controlled and ignored. */
  readonly trustVercelProxy: boolean;
}

/** Facts of the verified token that the principal (frozen seam) does not carry. */
export interface StaffSession {
  readonly email: string;
  readonly sessionId: string | null;
}

const sessions = new WeakMap<StaffPrincipal, StaffSession>();

/** Token facts for the principal that `authenticate` produced (used by `GET /v1/crm/me`). */
export function staffSessionOf(principal: StaffPrincipal): StaffSession | undefined {
  return sessions.get(principal);
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;
const UNKNOWN_IP_SUBJECT = 'unknown';

/** The token, or null. Anything but one well-formed `Authorization: Bearer` header is "no credential". */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined || header.length > MAX_TOKEN_LENGTH + 'Bearer '.length) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

function unauthorized(): HttpProblem {
  // Same status, code and headers for every reason: the response never tells which check failed (C9).
  return new HttpProblem(401, 'unauthorized', { headers: { 'WWW-Authenticate': 'Bearer' } });
}

export function createStaffGuards(deps: StaffGuardsDependencies): StaffGuards {
  const rejected = (reason: string): void => {
    deps.metrics.record('auth.staff_rejected', 1, { reason });
  };

  const authenticate = createMiddleware<StaffEnv>(async (c, next) => {
    const logger = c.get('logger');

    // 1. Per-IP limit BEFORE any cryptography or I/O on the token.
    const ip = resolveClientIp(c.req.raw, { trustVercelProxy: deps.trustVercelProxy });
    const ipSubject = ip === null ? UNKNOWN_IP_SUBJECT : deps.hmac(rateLimitSubject(ip));
    const ipVerdict = await deps.limiter.consume('ip', ipSubject);
    if (ipVerdict.outcome === 'limited') {
      deps.metrics.record('ratelimit.blocked', 1, { scope: 'crm_ip' });
      throw new HttpProblem(429, 'rate_limited', {
        retryAfterSeconds: ipVerdict.retryAfterSeconds,
      });
    }
    if (ipVerdict.outcome === 'unavailable') {
      deps.metrics.record('ratelimit.fail_open', 1, { scope: 'crm_ip' });
      logger.warn({ scope: 'crm_ip' }, 'rate limit backend unavailable; failing open');
    }

    // 2. Credential: only the Authorization header (never query string or cookie).
    const token = extractBearerToken(c.req.header('Authorization'));
    if (token === null) {
      rejected('missing_credential');
      throw unauthorized();
    }

    // 3. Signature, algorithm, issuer, audience, time window, account type.
    let verified;
    try {
      verified = await deps.verifier.verify(token);
    } catch (error) {
      if (error instanceof SigningKeysUnavailableError) {
        rejected('keys_unavailable');
        throw new DependencyUnavailableError('identity_provider', { cause: error });
      }
      if (error instanceof InvalidAccessTokenError) {
        rejected(error.reason);
        throw unauthorized();
      }
      throw error;
    }

    // 4. Workspace and role from the database, on every request (never from claims).
    const lookup = await deps.memberships.resolve(verified.userId);
    if (lookup.kind !== 'member') {
      rejected(lookup.kind === 'none' ? 'no_active_membership' : 'ambiguous_membership');
      // The internal user id is not PII; the reason stays in the log, never in the response.
      logger.warn({ user_id: verified.userId, reason: lookup.kind }, 'staff access denied');
      throw new HttpProblem(403, 'forbidden');
    }

    const principal: StaffPrincipal = {
      userId: verified.userId,
      workspaceId: lookup.membership.workspaceId,
      role: lookup.membership.role,
      displayName: lookup.membership.displayName,
      aal: verified.aal,
      mfaVerifiedAt: verified.mfaVerifiedAt,
    };
    sessions.set(principal, { email: verified.email, sessionId: verified.sessionId });
    c.set('staff', principal);
    await next();
  });

  const rateLimit = (
    bucket: StaffRateBucket,
    fail: RateLimitFailMode,
  ): MiddlewareHandler<StaffEnv> =>
    createMiddleware<StaffEnv>(async (c, next) => {
      const staff = c.var.staff as StaffPrincipal | undefined;
      if (staff === undefined) {
        // Wiring bug (route without `authenticate`): fail closed rather than limit an anonymous caller.
        throw unauthorized();
      }
      const scope: StaffLimitScope = bucket;
      const verdict = await deps.limiter.consume(
        scope,
        userSubject(staff.workspaceId, staff.userId),
      );
      if (verdict.outcome === 'limited') {
        deps.metrics.record('ratelimit.blocked', 1, { scope: `crm_${bucket}` });
        throw new HttpProblem(429, 'rate_limited', {
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
      }
      if (verdict.outcome === 'unavailable') {
        if (fail === 'closed') {
          deps.metrics.record('ratelimit.blocked', 1, {
            scope: `crm_${bucket}`,
            reason: 'backend_unavailable',
          });
          c.get('logger').warn(
            { scope: `crm_${bucket}` },
            'rate limit backend unavailable; failing closed',
          );
          throw new HttpProblem(503, 'service_unavailable', {
            retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS,
          });
        }
        deps.metrics.record('ratelimit.fail_open', 1, { scope: `crm_${bucket}` });
        c.get('logger').warn(
          { scope: `crm_${bucket}` },
          'rate limit backend unavailable; failing open',
        );
      }
      await next();
    });

  return { authenticate, rateLimit };
}

/** Keys are partitioned by workspace and user (internal ids, no PII). */
function userSubject(workspaceId: string, userId: UserId): string {
  return `${workspaceId}:${userId}`;
}
