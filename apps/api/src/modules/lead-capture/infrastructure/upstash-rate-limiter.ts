import { Ratelimit, type Duration } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';
import type {
  Clock,
  RateLimitDecision,
  RateLimiter,
} from '#/modules/lead-capture/application/ports.ts';
import type { HmacHasher } from '#/platform/crypto/hashing.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import { rateLimitSubject } from '#/platform/net/client-ip.ts';

/** Outbound Redis timeout (000-overview §5.4). Past it the check fails open. */
export const RATE_LIMIT_REDIS_TIMEOUT_MS = 1_000;

/** lead-capture §6: ≥ 10 failed Turnstile verifications in 10 minutes block the IP for 1 hour. */
export const BOT_FAILURE_THRESHOLD = 10;
export const BOT_BLOCK_SECONDS = 3_600;

const MS_PER_SECOND = 1_000;
const KEY_ROOT = 'lp:rl';

/** Window sizes from lead-capture §6, in one place so spec and code are easy to compare. */
const LIMITS = {
  ipShort: { tokens: 5, window: '10 m' },
  ipDaily: { tokens: 30, window: '1 d' },
  form: { tokens: 300, window: '1 m' },
  email: { tokens: 3, window: '1 h' },
  botFailures: { tokens: BOT_FAILURE_THRESHOLD, window: '10 m' },
} as const;

export interface WindowLimitResult {
  readonly success: boolean;
  /** Tokens left after this call. */
  readonly remaining: number;
  /** Unix timestamp in milliseconds at which the current window ends. */
  readonly reset: number;
  /** Set by `@upstash/ratelimit` ("timeout") when it gave up on Redis and let the call pass. */
  readonly reason?: string;
}

/** The slice of `@upstash/ratelimit`'s `Ratelimit` this adapter uses. */
export interface WindowLimiter {
  limit(identifier: string): Promise<WindowLimitResult>;
}

export interface RateLimitWindows {
  readonly ipShort: WindowLimiter;
  readonly ipDaily: WindowLimiter;
  readonly form: WindowLimiter;
  readonly email: WindowLimiter;
  readonly botFailures: WindowLimiter;
}

/** The slice of the `@upstash/redis` client used for the temporary bot block. */
export interface BlockRedis {
  /** Remaining time to live in milliseconds; -2 when the key does not exist. */
  pttl(key: string): Promise<number>;
  set(key: string, value: string, options: { readonly ex: number }): Promise<unknown>;
}

/**
 * Builds the sliding-window limiters on top of the Upstash REST client. The in-memory
 * ephemeral cache and analytics are off: both would add hidden state (and extra Redis writes)
 * to what must stay a plain, auditable counter.
 */
export function createUpstashRateLimitWindows(
  redis: Redis,
  options: { readonly timeoutMs?: number } = {},
): RateLimitWindows {
  const timeout = options.timeoutMs ?? RATE_LIMIT_REDIS_TIMEOUT_MS;
  const build = (name: string, limit: { tokens: number; window: Duration }) =>
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit.tokens, limit.window),
      prefix: `${KEY_ROOT}:${name}`,
      ephemeralCache: false,
      analytics: false,
      timeout,
    });
  return {
    ipShort: build('ip10m', LIMITS.ipShort),
    ipDaily: build('ip24h', LIMITS.ipDaily),
    form: build('form', LIMITS.form),
    email: build('email', LIMITS.email),
    botFailures: build('botfail', LIMITS.botFailures),
  };
}

export interface UpstashRateLimiterDependencies {
  readonly windows: RateLimitWindows;
  readonly blocks: BlockRedis;
  /** HMAC-SHA256 with `HASH_PEPPER`: every identifier is hashed before it reaches a Redis key. */
  readonly hmac: HmacHasher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly redisTimeoutMs?: number;
}

type Scope = 'ip' | 'ip_daily' | 'ip_bot_block' | 'form' | 'email' | 'bot_failure';

/** Outcome of one guarded Redis call: a value, or "Redis did not answer in time / errored". */
type Guarded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

type WindowOutcome = 'allowed' | 'fail_open' | { readonly retryAfterSeconds: number };

const ALLOWED: RateLimitDecision = { allowed: true };

/**
 * `RateLimiter` backed by Upstash Redis (lead-capture §2 steps 4 and 10, §6).
 *
 * Fail-open by design (spec §7, threat model): when Redis errors or exceeds the timeout the
 * request is allowed, a `ratelimit.fail_open` metric is recorded and a PII-free warning is
 * logged. Turnstile remains mandatory, so this only degrades abuse limits, never authentication.
 */
export function createUpstashRateLimiter(deps: UpstashRateLimiterDependencies): RateLimiter {
  const timeoutMs = deps.redisTimeoutMs ?? RATE_LIMIT_REDIS_TIMEOUT_MS;

  const failOpen = (scope: Scope, cause: 'error' | 'timeout'): void => {
    deps.metrics.record('ratelimit.fail_open', 1, { scope });
    // Only the scope and cause: Redis errors can echo the failing command, keys included.
    deps.logger.warn({ scope, cause }, 'rate limit backend unavailable; failing open');
  };

  const guarded = async <T>(scope: Scope, call: () => Promise<T>): Promise<Guarded<T>> => {
    try {
      return { ok: true, value: await withTimeout(call(), timeoutMs) };
    } catch (error) {
      failOpen(scope, error instanceof RedisTimeoutError ? 'timeout' : 'error');
      return { ok: false };
    }
  };

  const retryAfterSeconds = (resetAtMs: number): number =>
    Math.max(1, Math.ceil((resetAtMs - deps.clock.now().getTime()) / MS_PER_SECOND));

  const blocked = (scope: Scope, seconds: number): RateLimitDecision => {
    deps.metrics.record('ratelimit.blocked', 1, { scope });
    return { allowed: false, retryAfterSeconds: seconds };
  };

  const consume = async (
    scope: Scope,
    limiter: WindowLimiter,
    identifier: string,
  ): Promise<WindowOutcome> => {
    const outcome = await guarded(scope, () => limiter.limit(identifier));
    if (!outcome.ok) return 'fail_open';
    if (outcome.value.reason === 'timeout') {
      // The library resolved "success" because Redis was too slow; that is a fail-open, not a pass.
      failOpen(scope, 'timeout');
      return 'fail_open';
    }
    return outcome.value.success
      ? 'allowed'
      : { retryAfterSeconds: retryAfterSeconds(outcome.value.reset) };
  };

  const checkSingleWindow = async (
    scope: Scope,
    limiter: WindowLimiter,
    identifier: string,
  ): Promise<RateLimitDecision> => {
    const outcome = await consume(scope, limiter, identifier);
    return typeof outcome === 'object' ? blocked(scope, outcome.retryAfterSeconds) : ALLOWED;
  };

  const botBlockKey = (ipIdentifier: string): string => `${KEY_ROOT}:botblock:${ipIdentifier}`;
  const ipIdentifier = (clientIp: string): string => deps.hmac(rateLimitSubject(clientIp));

  return {
    async checkIp(clientIp) {
      const identifier = ipIdentifier(clientIp);

      // 1. Temporary block earned by repeated Turnstile failures. Checked first so a blocked IP
      //    does not burn quota on the sliding windows below.
      const block = await guarded('ip_bot_block', () => deps.blocks.pttl(botBlockKey(identifier)));
      if (!block.ok) return ALLOWED; // Redis is down: skip the remaining (slow) calls too.
      if (block.value > 0) {
        return blocked('ip_bot_block', Math.max(1, Math.ceil(block.value / MS_PER_SECOND)));
      }

      // 2. 5 requests / 10 min, then 3. 30 requests / 24 h.
      const short = await consume('ip', deps.windows.ipShort, identifier);
      if (short === 'fail_open') return ALLOWED;
      if (short !== 'allowed') return blocked('ip', short.retryAfterSeconds);

      const daily = await consume('ip_daily', deps.windows.ipDaily, identifier);
      return typeof daily === 'object' ? blocked('ip_daily', daily.retryAfterSeconds) : ALLOWED;
    },

    checkForm(formKey) {
      return checkSingleWindow('form', deps.windows.form, deps.hmac(formKey));
    },

    checkEmail(normalizedEmail) {
      return checkSingleWindow('email', deps.windows.email, deps.hmac(normalizedEmail));
    },

    async recordBotFailure(clientIp) {
      const identifier = ipIdentifier(clientIp);
      const failures = await guarded('bot_failure', () =>
        deps.windows.botFailures.limit(identifier),
      );
      if (!failures.ok) return;
      if (failures.value.reason === 'timeout') {
        failOpen('bot_failure', 'timeout');
        return;
      }
      // The threshold-th failure uses the last token; any further one is rejected by the window.
      if (failures.value.success && failures.value.remaining > 0) return;

      const set = await guarded('bot_failure', () =>
        deps.blocks.set(botBlockKey(identifier), '1', { ex: BOT_BLOCK_SECONDS }),
      );
      if (set.ok) {
        deps.logger.info({ blockSeconds: BOT_BLOCK_SECONDS }, 'client blocked after bot failures');
      }
    },
  };
}

class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`redis call exceeded ${timeoutMs} ms`);
    this.name = 'RedisTimeoutError';
  }
}

/** Rejects when `operation` does not settle in time. The timer is always cleared. */
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
