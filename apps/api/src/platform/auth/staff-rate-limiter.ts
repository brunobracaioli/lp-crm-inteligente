import { Ratelimit, type Duration } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';
import type { StaffRateBucket } from '#/platform/auth/staff.ts';
import type { Clock } from '#/shared/time.ts';

/**
 * Per-user limits of the staff API (contract `x-rate-limit`, threat model C37/C38) plus the per-IP limit that
 * runs BEFORE the token is verified (so a flood of garbage tokens costs a Redis call, not a signature check).
 */

export type StaffLimitScope = StaffRateBucket | 'ip';

export interface StaffLimit {
  readonly limit: number;
  readonly windowSeconds: number;
}

export const STAFF_RATE_LIMITS: Readonly<Record<StaffLimitScope, StaffLimit>> = {
  read: { limit: 120, windowSeconds: 60 },
  write: { limit: 30, windowSeconds: 60 },
  export: { limit: 5, windowSeconds: 3600 },
  /** Generous on purpose: a whole office may share one NAT address. Not in the contract (open question). */
  ip: { limit: 600, windowSeconds: 60 },
};

export type StaffRateVerdict =
  | { readonly outcome: 'allowed' }
  | { readonly outcome: 'limited'; readonly retryAfterSeconds: number }
  /** The backend (Redis) did not answer; the caller applies the route's `fail` mode. */
  | { readonly outcome: 'unavailable' };

export interface StaffRateLimiter {
  /**
   * Consumes one unit of `scope` for `subject` (an opaque, PII-free key such as `<workspace>:<user>` or the
   * HMAC of an IP). Must not throw: a backend failure is reported as `unavailable`.
   */
  consume(scope: StaffLimitScope, subject: string): Promise<StaffRateVerdict>;
}

/** Outbound Redis timeout (000-overview §5.4). */
export const STAFF_RATE_LIMIT_TIMEOUT_MS = 1000;
const KEY_PREFIX = 'lp:rl:crm';
const MS_PER_SECOND = 1000;

/** The slice of `@upstash/ratelimit`'s `Ratelimit` this adapter uses. */
export interface StaffWindowLimiter {
  limit(identifier: string): Promise<{
    readonly success: boolean;
    /** Unix milliseconds at which the current window ends. */
    readonly reset: number;
    /** Set to "timeout" by the library when it gave up on Redis and let the call pass. */
    readonly reason?: string;
  }>;
}

export type StaffWindowLimiters = Readonly<Record<StaffLimitScope, StaffWindowLimiter>>;

/** Sliding-window limiters on the Upstash REST client; ephemeral cache and analytics stay off (plain counters). */
export function createUpstashStaffWindowLimiters(
  redis: Redis,
  options: { readonly timeoutMs?: number } = {},
): StaffWindowLimiters {
  const build = (scope: StaffLimitScope): Ratelimit => {
    const { limit, windowSeconds } = STAFF_RATE_LIMITS[scope];
    return new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s` as Duration),
      prefix: `${KEY_PREFIX}:${scope}`,
      ephemeralCache: false,
      analytics: false,
      timeout: options.timeoutMs ?? STAFF_RATE_LIMIT_TIMEOUT_MS,
    });
  };
  return {
    read: build('read'),
    write: build('write'),
    export: build('export'),
    ip: build('ip'),
  };
}

export interface UpstashStaffRateLimiterDependencies {
  readonly windows: StaffWindowLimiters;
  readonly clock: Clock;
  readonly timeoutMs?: number;
}

class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`redis call exceeded ${timeoutMs} ms`);
    this.name = 'RedisTimeoutError';
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RedisTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createUpstashStaffRateLimiter(
  deps: UpstashStaffRateLimiterDependencies,
): StaffRateLimiter {
  const timeoutMs = deps.timeoutMs ?? STAFF_RATE_LIMIT_TIMEOUT_MS;
  return {
    async consume(scope, subject) {
      try {
        const result = await withTimeout(deps.windows[scope].limit(subject), timeoutMs);
        if (result.reason === 'timeout') {
          return { outcome: 'unavailable' };
        }
        if (result.success) {
          return { outcome: 'allowed' };
        }
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((result.reset - deps.clock.now().getTime()) / MS_PER_SECOND),
        );
        return { outcome: 'limited', retryAfterSeconds };
      } catch {
        // The error may echo the failing command (keys included): nothing of it leaves this adapter.
        return { outcome: 'unavailable' };
      }
    },
  };
}
