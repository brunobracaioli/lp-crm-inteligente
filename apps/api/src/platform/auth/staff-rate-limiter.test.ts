import { describe, expect, it } from 'vitest';
import { FakeClock } from '#test/fakes/clock.ts';
import {
  createUpstashStaffRateLimiter,
  type StaffWindowLimiter,
  type StaffWindowLimiters,
} from './staff-rate-limiter.ts';

const clock = new FakeClock(new Date('2026-11-04T12:00:00.000Z'));

function limiters(window: StaffWindowLimiter): StaffWindowLimiters {
  return { read: window, write: window, export: window, ip: window };
}

function limiterOver(window: StaffWindowLimiter, timeoutMs = 50) {
  return createUpstashStaffRateLimiter({ windows: limiters(window), clock, timeoutMs });
}

describe('createUpstashStaffRateLimiter', () => {
  it('allows when the window has capacity', async () => {
    const limiter = limiterOver({ limit: () => Promise.resolve({ success: true, reset: 0 }) });
    expect(await limiter.consume('read', 'ws:user')).toEqual({ outcome: 'allowed' });
  });

  it('limits with a Retry-After derived from the window reset', async () => {
    const reset = clock.now().getTime() + 12_300;
    const limiter = limiterOver({ limit: () => Promise.resolve({ success: false, reset }) });
    expect(await limiter.consume('write', 'ws:user')).toEqual({
      outcome: 'limited',
      retryAfterSeconds: 13,
    });
  });

  it('never reports less than one second of Retry-After', async () => {
    const limiter = limiterOver({
      limit: () => Promise.resolve({ success: false, reset: clock.now().getTime() - 5 }),
    });
    expect(await limiter.consume('export', 'ws:user')).toMatchObject({ retryAfterSeconds: 1 });
  });

  it('reports unavailable when the library gave up on Redis (reason timeout)', async () => {
    const limiter = limiterOver({
      limit: () => Promise.resolve({ success: true, reset: 0, reason: 'timeout' }),
    });
    expect(await limiter.consume('read', 'x')).toEqual({ outcome: 'unavailable' });
  });

  it('reports unavailable, without throwing, when Redis errors', async () => {
    const limiter = limiterOver({
      limit: () => Promise.reject(new Error('UrlError: https://x.upstash.io/ token=secret')),
    });
    expect(await limiter.consume('ip', 'x')).toEqual({ outcome: 'unavailable' });
  });

  it('reports unavailable when Redis does not answer in time', async () => {
    const limiter = limiterOver({ limit: () => new Promise(() => undefined) }, 1);
    expect(await limiter.consume('read', 'x')).toEqual({ outcome: 'unavailable' });
  });

  it('sends the subject to the window of the requested scope only', async () => {
    const seen: string[] = [];
    const record = (scope: string): StaffWindowLimiter => ({
      limit: (id) => {
        seen.push(`${scope}:${id}`);
        return Promise.resolve({ success: true, reset: 0 });
      },
    });
    const limiter = createUpstashStaffRateLimiter({
      windows: {
        read: record('read'),
        write: record('write'),
        export: record('export'),
        ip: record('ip'),
      },
      clock,
    });

    await limiter.consume('export', 'ws:user');

    expect(seen).toEqual(['export:ws:user']);
  });
});
