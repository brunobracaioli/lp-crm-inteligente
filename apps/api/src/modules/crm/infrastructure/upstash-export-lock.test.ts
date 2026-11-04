import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import {
  createUpstashExportLock,
  EXPORT_LOCK_TTL_MS,
  type ExportLockRedis,
} from '#/modules/crm/infrastructure/upstash-export-lock.ts';

const WORKSPACE = '00000000-0000-7000-8000-00000000a001' as WorkspaceId;
const USER = '00000000-0000-7000-8000-0000000000e2' as UserId;
const OTHER_USER = '00000000-0000-7000-8000-0000000000e3' as UserId;

/** Redis with the operations of the lock: SET NX PX, GET and DEL. */
class FakeRedis implements ExportLockRedis {
  readonly values = new Map<string, string>();
  readonly setCalls: { key: string; px: number }[] = [];
  failure: Error | null = null;
  hang = false;

  set(key: string, value: string, options: { px: number; nx: true }): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.hang) return new Promise(() => undefined);
    this.setCalls.push({ key, px: options.px });
    if (this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.values.get(key) ?? null);
  }

  del(key: string): Promise<unknown> {
    this.values.delete(key);
    return Promise.resolve(1);
  }
}

function build(redis: FakeRedis, tokens: string[] = ['t1', 't2', 't3']) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const queue = [...tokens];
  const lock = createUpstashExportLock({
    redis,
    logger: createLogger({ level: 'debug', appEnv: 'test', destination }),
    timeoutMs: 20,
    newToken: () => queue.shift() ?? 'fallback',
  });
  return { lock, lines };
}

describe('createUpstashExportLock', () => {
  it('grants one lease per user and refuses the second until the first is released', async () => {
    // arrange
    const redis = new FakeRedis();
    const { lock } = build(redis);
    // act
    const first = await lock.acquire(WORKSPACE, USER);
    const second = await lock.acquire(WORKSPACE, USER);
    await first?.release();
    const third = await lock.acquire(WORKSPACE, USER);
    // assert
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).not.toBeNull();
  });

  it('partitions the lock by workspace and user and sets the TTL', async () => {
    const redis = new FakeRedis();
    const { lock } = build(redis);

    await lock.acquire(WORKSPACE, USER);
    const other = await lock.acquire(WORKSPACE, OTHER_USER);

    expect(other).not.toBeNull();
    expect(redis.setCalls.map((call) => call.px)).toEqual([EXPORT_LOCK_TTL_MS, EXPORT_LOCK_TTL_MS]);
    expect(new Set(redis.setCalls.map((call) => call.key)).size).toBe(2);
  });

  it('does not free a lock that now belongs to another export (late release)', async () => {
    const redis = new FakeRedis();
    const { lock } = build(redis);
    const first = await lock.acquire(WORKSPACE, USER);
    // the first lease expired and a second export took the lock
    redis.values.clear();
    await lock.acquire(WORKSPACE, USER);

    await first?.release();

    expect(await lock.acquire(WORKSPACE, USER)).toBeNull();
  });

  it('is fail-closed: a Redis error or timeout rejects with DependencyUnavailableError', async () => {
    const failing = new FakeRedis();
    failing.failure = new Error('boom');
    const hanging = new FakeRedis();
    hanging.hang = true;

    await expect(build(failing).lock.acquire(WORKSPACE, USER)).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    await expect(build(hanging).lock.acquire(WORKSPACE, USER)).rejects.toMatchObject({
      dependency: 'cache',
    });
  });

  it('swallows a failed release (the TTL frees the lock) and logs without the error text', async () => {
    const redis = new FakeRedis();
    const { lock, lines } = build(redis);
    const lease = await lock.acquire(WORKSPACE, USER);
    redis.failure = new Error('secret-detail');

    await expect(lease?.release()).resolves.toBeUndefined();

    expect(lines.join('')).toContain('export lock release failed');
    expect(lines.join('')).not.toContain('secret-detail');
  });
});
