import { Writable } from 'node:stream';
import type { Redis } from '@upstash/redis';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Clock, RateLimiter } from '#/modules/lead-capture/application/ports.ts';
import {
  BOT_BLOCK_SECONDS,
  createUpstashRateLimitWindows,
  createUpstashRateLimiter,
  type BlockRedis,
} from '#/modules/lead-capture/infrastructure/upstash-rate-limiter.ts';
import { createHmacHasher } from '#/platform/crypto/hashing.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';

const PEPPER = Buffer.alloc(32, 9).toString('base64');
const hmac = createHmacHasher(PEPPER);

const START = new Date('2026-11-03T12:00:00.000Z'); // aligned to the 1 m, 10 m and 1 h buckets
const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.20';
const EMAIL = 'maria.silva@empresa.com.br';
const FORM_KEY = 'frm_lp_principal';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

type Command = 'evalsha' | 'pttl' | 'set';
type Failure = 'error' | 'hang';

/**
 * In-memory stand-in for the Upstash REST client. `evalsha` reproduces the sliding-window Lua
 * script of @upstash/ratelimit 2.2.0, so the real library runs end to end against it and every
 * Redis key it builds is recorded. Time comes from the (faked) `Date.now()`.
 */
class FakeUpstash implements BlockRedis {
  readonly commands: { readonly command: Command; readonly keys: readonly string[] }[] = [];
  readonly failures: Partial<Record<Command, Failure>> = {};
  private readonly counters = new Map<string, number>();
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  get keys(): string[] {
    return this.commands.flatMap((entry) => entry.keys);
  }

  commandCount(command: Command): number {
    return this.commands.filter((entry) => entry.command === command).length;
  }

  evalsha(_sha: string, keys: string[], args: (string | number)[]): Promise<[number, number]> {
    return this.run('evalsha', keys, () => {
      const [currentKey = '', previousKey = ''] = keys;
      const [tokens = 0, now = 0, window = 1, increment = 1] = args.map(Number);
      const current = this.counters.get(currentKey) ?? 0;
      const previous = this.counters.get(previousKey) ?? 0;
      const weightedPrevious = Math.floor((1 - (now % window) / window) * previous);
      if (weightedPrevious + current >= tokens) return [-1, tokens];
      const next = current + increment;
      this.counters.set(currentKey, next);
      return [tokens - (next + weightedPrevious), tokens];
    });
  }

  pttl(key: string): Promise<number> {
    return this.run('pttl', [key], () => {
      const entry = this.entries.get(key);
      if (entry === undefined || entry.expiresAt <= Date.now()) return -2;
      return entry.expiresAt - Date.now();
    });
  }

  set(key: string, value: string, options: { readonly ex: number }): Promise<unknown> {
    return this.run('set', [key], () => {
      this.entries.set(key, { value, expiresAt: Date.now() + options.ex * SECOND_MS });
      return 'OK';
    });
  }

  private run<T>(command: Command, keys: readonly string[], execute: () => T): Promise<T> {
    this.commands.push({ command, keys });
    const failure = this.failures[command];
    if (failure === 'hang') return new Promise<T>(() => undefined);
    if (failure === 'error') return Promise.reject(new Error('fetch failed: ECONNREFUSED'));
    return Promise.resolve(execute());
  }
}

function setup() {
  const redis = new FakeUpstash();
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'debug', appEnv: 'test', destination });
  const metrics = createRecordingMetrics();
  const clock: Clock = { now: () => new Date(Date.now()), sleep: () => Promise.resolve() };
  const limiter: RateLimiter = createUpstashRateLimiter({
    windows: createUpstashRateLimitWindows(redis as unknown as Redis),
    blocks: redis,
    hmac,
    clock,
    logger,
    metrics,
  });
  return { limiter, redis, metrics, logs: () => lines.join('') };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Upstash client seams', () => {
  it('is satisfied by the real @upstash/redis client', () => {
    expectTypeOf<Redis>().toExtend<BlockRedis>();
  });
});

describe('checkIp', () => {
  it('allows 5 requests in 10 minutes and blocks the 6th with the time left in the window', async () => {
    // arrange
    const { limiter, metrics } = setup();
    // act
    const firstFive = [];
    for (let i = 0; i < 5; i += 1) {
      firstFive.push(await limiter.checkIp(IP));
      await advance(SECOND_MS);
    }
    await advance(95 * SECOND_MS); // now at START + 100 s
    const sixth = await limiter.checkIp(IP);
    // assert
    expect(firstFive).toEqual(Array.from({ length: 5 }, () => ({ allowed: true })));
    expect(sixth).toEqual({ allowed: false, retryAfterSeconds: 500 }); // window ends at START + 600 s
    expect(metrics.records).toEqual([
      { name: 'ratelimit.blocked', value: 1, attributes: { scope: 'ip' } },
    ]);
  });

  it('never reports a Retry-After below one second', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.checkIp(IP);
    await advance(10 * MINUTE_MS - 1); // 1 ms before the bucket ends
    expect(await limiter.checkIp(IP)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('lets the IP through again once the window has passed', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.checkIp(IP);
    expect((await limiter.checkIp(IP)).allowed).toBe(false);
    await advance(20 * MINUTE_MS);
    expect(await limiter.checkIp(IP)).toEqual({ allowed: true });
  });

  it('keeps counters per IP', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.checkIp(IP);
    expect((await limiter.checkIp(IP)).allowed).toBe(false);
    expect(await limiter.checkIp(OTHER_IP)).toEqual({ allowed: true });
  });

  it('blocks the 31st request in 24 hours even when each 10-minute window is respected', async () => {
    // arrange
    const { limiter, metrics } = setup();
    // act: 6 batches of 5 requests, 20 minutes apart (30 requests)
    for (let batch = 0; batch < 6; batch += 1) {
      for (let i = 0; i < 5; i += 1) {
        expect(await limiter.checkIp(IP), `batch ${batch} request ${i}`).toEqual({ allowed: true });
      }
      await advance(20 * MINUTE_MS);
    }
    const overDaily = await limiter.checkIp(IP);
    // assert: START + 2 h = 14:00 UTC; the day bucket ends at midnight, 10 h later
    expect(overDaily).toEqual({ allowed: false, retryAfterSeconds: 10 * 3_600 });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.blocked', value: 1, attributes: { scope: 'ip_daily' } },
    ]);
  });

  it('shares one budget across every address of the same IPv6 /64', async () => {
    const { limiter } = setup();
    const sameSubnet = [
      '2001:db8:aaaa:bbbb::1',
      '2001:db8:aaaa:bbbb::2',
      '2001:db8:aaaa:bbbb:1:2:3:4',
      '2001:db8:aaaa:bbbb:ffff::9',
      '2001:db8:aaaa:bbbb::5',
    ];
    for (const address of sameSubnet) {
      expect(await limiter.checkIp(address)).toEqual({ allowed: true });
    }
    expect((await limiter.checkIp('2001:db8:aaaa:bbbb::dead')).allowed).toBe(false);
    expect((await limiter.checkIp('2001:db8:aaaa:cccc::1')).allowed).toBe(true);
  });
});

describe('bot failure block', () => {
  it('blocks an IP for one hour after 10 failed verifications in 10 minutes', async () => {
    // arrange
    const { limiter, redis, metrics } = setup();
    // act
    for (let i = 0; i < 9; i += 1) await limiter.recordBotFailure(IP);
    const beforeThreshold = await limiter.checkIp(IP);
    await limiter.recordBotFailure(IP);
    const commandsBeforeBlockedCheck = redis.commands.length;
    const blocked = await limiter.checkIp(IP);
    // assert
    expect(beforeThreshold).toEqual({ allowed: true });
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: BOT_BLOCK_SECONDS });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.blocked', value: 1, attributes: { scope: 'ip_bot_block' } },
    ]);
    // a blocked IP costs one lookup and does not burn quota on the sliding windows
    expect(redis.commands.slice(commandsBeforeBlockedCheck).map((entry) => entry.command)).toEqual([
      'pttl',
    ]);
  });

  it('reports the remaining block time as Retry-After and lifts the block after one hour', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 10; i += 1) await limiter.recordBotFailure(IP);
    await advance(30 * MINUTE_MS);
    expect(await limiter.checkIp(IP)).toEqual({ allowed: false, retryAfterSeconds: 1_800 });
    await advance(30 * MINUTE_MS + SECOND_MS);
    expect(await limiter.checkIp(IP)).toEqual({ allowed: true });
  });

  it('does not block when the failures are spread over more than 10 minutes', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 9; i += 1) await limiter.recordBotFailure(IP);
    await advance(20 * MINUTE_MS);
    for (let i = 0; i < 9; i += 1) await limiter.recordBotFailure(IP);
    expect(await limiter.checkIp(IP)).toEqual({ allowed: true });
  });

  it('keeps the block specific to the offending IP', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 10; i += 1) await limiter.recordBotFailure(IP);
    expect((await limiter.checkIp(IP)).allowed).toBe(false);
    expect(await limiter.checkIp(OTHER_IP)).toEqual({ allowed: true });
  });
});

describe('checkEmail', () => {
  it('allows 3 submissions per hour and blocks the 4th with Retry-After', async () => {
    // arrange
    const { limiter, metrics } = setup();
    // act
    const first = [];
    for (let i = 0; i < 3; i += 1) first.push(await limiter.checkEmail(EMAIL));
    await advance(10 * MINUTE_MS);
    const fourth = await limiter.checkEmail(EMAIL);
    // assert
    expect(first).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);
    expect(fourth).toEqual({ allowed: false, retryAfterSeconds: 50 * 60 });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.blocked', value: 1, attributes: { scope: 'email' } },
    ]);
  });

  it('counts each e-mail address separately', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i += 1) await limiter.checkEmail(EMAIL);
    expect((await limiter.checkEmail(EMAIL)).allowed).toBe(false);
    expect((await limiter.checkEmail('outra.pessoa@empresa.com.br')).allowed).toBe(true);
  });
});

describe('checkForm', () => {
  it('allows 300 requests per minute per form and blocks the 301st until the minute ends', async () => {
    // arrange
    const { limiter, metrics } = setup();
    // act
    for (let i = 0; i < 300; i += 1) {
      expect((await limiter.checkForm(FORM_KEY)).allowed).toBe(true);
    }
    await advance(15 * SECOND_MS);
    const over = await limiter.checkForm(FORM_KEY);
    // assert
    expect(over).toEqual({ allowed: false, retryAfterSeconds: 45 });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.blocked', value: 1, attributes: { scope: 'form' } },
    ]);
    expect((await limiter.checkForm('frm_outro_form')).allowed).toBe(true);
  });
});

describe('Redis keys', () => {
  it('are built from HMACs only: no raw IP, e-mail or form key ever reaches Redis', async () => {
    // arrange
    const { limiter, redis } = setup();
    // act: exercise every operation, including the bot block
    await limiter.checkIp(IP);
    await limiter.checkIp('2001:db8:aaaa:bbbb::1');
    await limiter.checkEmail(EMAIL);
    await limiter.checkForm(FORM_KEY);
    for (let i = 0; i < 10; i += 1) await limiter.recordBotFailure(IP);
    await limiter.checkIp(IP);
    // assert
    const keys = redis.keys;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^lp:rl:(ip10m|ip24h|form|email|botfail|botblock):[0-9a-f]{64}(:\d+)?$/);
      for (const raw of ['203.0.113', '2001', 'db8', 'maria', 'silva', 'empresa', '@', 'frm_']) {
        expect(key).not.toContain(raw);
      }
    }
    const identifiers = new Set(keys.map((key) => key.split(':')[3]));
    expect(identifiers).toEqual(
      new Set([hmac(IP), hmac('2001:db8:aaaa:bbbb::/64'), hmac(EMAIL), hmac(FORM_KEY)]),
    );
  });

  it('separate the namespaces so one identifier cannot consume another limiter budget', async () => {
    const { limiter, redis } = setup();
    await limiter.checkIp(IP);
    const namespaces = new Set(redis.keys.map((key) => key.split(':')[2]));
    expect(namespaces).toEqual(new Set(['botblock', 'ip10m', 'ip24h']));
  });
});

describe('fail-open when Redis is unavailable', () => {
  it('allows the IP, records ratelimit.fail_open and skips the remaining Redis calls', async () => {
    // arrange
    const { limiter, redis, metrics, logs } = setup();
    redis.failures.pttl = 'error';
    redis.failures.evalsha = 'error';
    // act
    const decision = await limiter.checkIp(IP);
    // assert
    expect(decision).toEqual({ allowed: true });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'ip_bot_block' } },
    ]);
    expect(redis.commands.map((entry) => entry.command)).toEqual(['pttl']);
    expect(logs()).toContain('rate limit backend unavailable; failing open');
    expect(logs()).toContain('"level":"warn"');
  });

  it('allows the IP when the sliding window call fails', async () => {
    const { limiter, redis, metrics } = setup();
    redis.failures.evalsha = 'error';
    expect(await limiter.checkIp(IP)).toEqual({ allowed: true });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'ip' } },
    ]);
    expect(redis.commandCount('evalsha')).toBe(1); // the daily window is not attempted
  });

  it('allows the e-mail and form checks when the sliding window call fails', async () => {
    const { limiter, redis, metrics } = setup();
    redis.failures.evalsha = 'error';
    expect(await limiter.checkEmail(EMAIL)).toEqual({ allowed: true });
    expect(await limiter.checkForm(FORM_KEY)).toEqual({ allowed: true });
    expect(metrics.records.map((record) => record.attributes)).toEqual([
      { scope: 'email' },
      { scope: 'form' },
    ]);
  });

  it('allows the request when the sliding window does not answer within 1 second', async () => {
    // arrange
    const { limiter, redis, metrics, logs } = setup();
    redis.failures.evalsha = 'hang';
    // act
    const pending = limiter.checkIp(IP);
    await advance(999);
    const early = await Promise.race([pending, Promise.resolve('pending' as const)]);
    await advance(1);
    // assert
    expect(early).toBe('pending');
    expect(await pending).toEqual({ allowed: true });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'ip' } },
    ]);
    expect(logs()).toContain('"cause":"timeout"');
  });

  it('allows the request when the bot-block lookup does not answer within 1 second', async () => {
    const { limiter, redis, metrics } = setup();
    redis.failures.pttl = 'hang';
    const pending = limiter.checkIp(IP);
    await advance(1_000);
    expect(await pending).toEqual({ allowed: true });
    expect(metrics.records).toEqual([
      { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'ip_bot_block' } },
    ]);
  });

  it('never throws from recordBotFailure when Redis is down', async () => {
    const { limiter, redis, metrics } = setup();
    redis.failures.evalsha = 'error';
    await expect(limiter.recordBotFailure(IP)).resolves.toBeUndefined();
    expect(metrics.records).toEqual([
      { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'bot_failure' } },
    ]);
  });

  it('never throws when the failure counter does not answer within 1 second', async () => {
    const { limiter, redis, metrics } = setup();
    redis.failures.evalsha = 'hang';
    const pending = limiter.recordBotFailure(IP);
    await advance(1_000);
    await expect(pending).resolves.toBeUndefined();
    expect(metrics.records).toEqual([
      { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'bot_failure' } },
    ]);
  });

  it('never throws when writing the block fails', async () => {
    const { limiter, redis, metrics } = setup();
    redis.failures.set = 'error';
    for (let i = 0; i < 9; i += 1) await limiter.recordBotFailure(IP);
    await expect(limiter.recordBotFailure(IP)).resolves.toBeUndefined();
    expect(metrics.records).toEqual([
      { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'bot_failure' } },
    ]);
  });

  it('keeps raw IPs, e-mails and Redis error text out of the logs', async () => {
    // arrange
    const { limiter, redis, logs } = setup();
    redis.failures.pttl = 'error';
    redis.failures.evalsha = 'error';
    redis.failures.set = 'error';
    // act
    await limiter.checkIp(IP);
    await limiter.checkEmail(EMAIL);
    await limiter.checkForm(FORM_KEY);
    for (let i = 0; i < 10; i += 1) await limiter.recordBotFailure(IP);
    // assert
    const output = logs();
    expect(output.length).toBeGreaterThan(0);
    for (const sensitive of [IP, EMAIL, 'maria', FORM_KEY, hmac(IP), 'ECONNREFUSED']) {
      expect(output).not.toContain(sensitive);
    }
  });
});
