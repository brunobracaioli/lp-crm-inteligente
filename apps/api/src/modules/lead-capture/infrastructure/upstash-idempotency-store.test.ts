import { Writable } from 'node:stream';
import type { Redis } from '@upstash/redis';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  AcceptedSubmission,
  IdempotencyStore,
} from '#/modules/lead-capture/application/ports.ts';
import {
  createUpstashIdempotencyStore,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyRedis,
} from '#/modules/lead-capture/infrastructure/upstash-idempotency-store.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import type { EventId, IdempotencyKey, SubmissionId, WorkspaceId } from '#/shared/ids.ts';

const START = new Date('2026-11-03T12:00:00.000Z');
const SECOND_MS = 1_000;

const WORKSPACE = '0198b1c2-0000-7000-8000-000000000001' as WorkspaceId;
const OTHER_WORKSPACE = '0198b1c2-0000-7000-8000-000000000002' as WorkspaceId;
const KEY = '00000000-0000-4000-8000-000000000001' as IdempotencyKey;
const HASH_A = sha256Hex('normalized payload A');
const HASH_B = sha256Hex('normalized payload B');

const RESPONSE: AcceptedSubmission = {
  submissionId: '0198b1c2-1111-7000-8000-00000000000a' as SubmissionId,
  eventId: '0198b1c2-2222-7000-8000-00000000000b' as EventId,
};

type Command = 'set' | 'get' | 'del';
type Failure = 'error' | 'hang';

interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly options: { readonly ex: number; readonly nx?: true };
}

/** In-memory Redis with TTLs driven by the (faked) `Date.now()`. */
class FakeRedis implements IdempotencyRedis {
  readonly setCalls: SetCall[] = [];
  readonly commands: Command[] = [];
  readonly failures: Partial<Record<Command, Failure>> = {};
  /** The real client returns parsed JSON objects for JSON strings. */
  autoDeserialize = false;
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  set(key: string, value: string, options: { readonly ex: number; readonly nx?: true }) {
    return this.run('set', () => {
      this.setCalls.push({ key, value, options });
      if (options.nx === true && this.live(key) !== undefined) return null;
      this.entries.set(key, { value, expiresAt: Date.now() + options.ex * SECOND_MS });
      return 'OK';
    });
  }

  get(key: string) {
    return this.run('get', () => {
      const value = this.live(key);
      if (value === undefined) return null;
      return this.autoDeserialize ? (JSON.parse(value) as unknown) : value;
    });
  }

  del(key: string) {
    return this.run('del', () => (this.entries.delete(key) ? 1 : 0));
  }

  /** Test helper: bypasses failure injection. */
  peek(key: string): string | undefined {
    return this.live(key);
  }

  ttlSeconds(key: string): number | undefined {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : Math.round((entry.expiresAt - Date.now()) / SECOND_MS);
  }

  poke(key: string, value: string): void {
    this.entries.set(key, { value, expiresAt: Date.now() + IDEMPOTENCY_TTL_SECONDS * SECOND_MS });
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  private live(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.expiresAt <= Date.now()) return undefined;
    return entry.value;
  }

  private run<T>(command: Command, execute: () => T): Promise<T> {
    this.commands.push(command);
    const failure = this.failures[command];
    if (failure === 'hang') return new Promise<T>(() => undefined);
    if (failure === 'error') return Promise.reject(new Error('fetch failed: ECONNREFUSED'));
    return Promise.resolve(execute());
  }
}

const redisKey = (workspace: WorkspaceId = WORKSPACE, key: IdempotencyKey = KEY) =>
  `lp:idem:v1:${workspace}:${key}`;

function setup(options: { inProgressTtlSeconds?: number } = {}) {
  const redis = new FakeRedis();
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'debug', appEnv: 'test', destination });
  const store: IdempotencyStore = createUpstashIdempotencyStore({ redis, logger, ...options });
  return { store, redis, logs: () => lines.join('') };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Upstash client seam', () => {
  it('is satisfied by the real @upstash/redis client', () => {
    expectTypeOf<Redis>().toExtend<IdempotencyRedis>();
  });
});

describe('claim', () => {
  it('claims a new key with SET NX EX 86400 and the in_progress state', async () => {
    // arrange
    const { store, redis } = setup();
    // act
    const claim = await store.claim(WORKSPACE, KEY, HASH_A);
    // assert
    expect(claim).toEqual({ status: 'claimed' });
    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]?.key).toBe(redisKey());
    expect(redis.setCalls[0]?.options).toEqual({ nx: true, ex: 86_400 });
    expect(JSON.parse(redis.setCalls[0]?.value ?? '')).toEqual({
      v: 1,
      state: 'in_progress',
      requestHash: HASH_A,
    });
  });

  it('reports in_progress with the stored hash when the same key is claimed again', async () => {
    const { store } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({
      status: 'in_progress',
      requestHash: HASH_A,
    });
  });

  it('exposes the original hash so a different payload on the same key is detectable', async () => {
    // arrange
    const { store, redis } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    // act
    const second = await store.claim(WORKSPACE, KEY, HASH_B);
    // assert
    expect(second).toEqual({ status: 'in_progress', requestHash: HASH_A });
    expect(second).not.toEqual({ status: 'in_progress', requestHash: HASH_B });
    expect(JSON.parse(redis.peek(redisKey()) ?? '')).toMatchObject({ requestHash: HASH_A });
  });

  it('keeps keys independent across workspaces', async () => {
    const { store } = setup();
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({ status: 'claimed' });
    expect(await store.claim(OTHER_WORKSPACE, KEY, HASH_A)).toEqual({ status: 'claimed' });
  });

  it('claims the key again once the 24 h TTL has elapsed', async () => {
    const { store } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    await vi.advanceTimersByTimeAsync(86_399 * SECOND_MS);
    expect((await store.claim(WORKSPACE, KEY, HASH_A)).status).toBe('in_progress');
    await vi.advanceTimersByTimeAsync(2 * SECOND_MS);
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({ status: 'claimed' });
  });

  it('retries the claim once when the key vanishes between SET NX and GET', async () => {
    // arrange
    const { store, redis } = setup();
    redis.poke(redisKey(), JSON.stringify({ v: 1, state: 'in_progress', requestHash: HASH_B }));
    const originalGet = redis.get.bind(redis);
    vi.spyOn(redis, 'get').mockImplementationOnce(async (key) => {
      await originalGet(key);
      redis.forget(key); // released by the other request right after our failed SET NX
      return null;
    });
    // act
    const claim = await store.claim(WORKSPACE, KEY, HASH_A);
    // assert
    expect(claim).toEqual({ status: 'claimed' });
    expect(redis.commands).toEqual(['set', 'get', 'set']);
  });

  it('honours a shorter TTL for the in_progress marker when configured', async () => {
    const { store, redis } = setup({ inProgressTtlSeconds: 60 });
    await store.claim(WORKSPACE, KEY, HASH_A);
    expect(redis.setCalls[0]?.options).toEqual({ nx: true, ex: 60 });
    await vi.advanceTimersByTimeAsync(61 * SECOND_MS);
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({ status: 'claimed' });
  });
});

describe('complete', () => {
  it('stores the response so a later claim replays it, with the original hash', async () => {
    // arrange
    const { store, redis } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    // act
    await store.complete(WORKSPACE, KEY, HASH_A, RESPONSE);
    const replay = await store.claim(WORKSPACE, KEY, HASH_A);
    // assert
    expect(replay).toEqual({ status: 'completed', requestHash: HASH_A, response: RESPONSE });
    expect(JSON.parse(redis.peek(redisKey()) ?? '')).toEqual({
      v: 1,
      state: 'completed',
      requestHash: HASH_A,
      submissionId: RESPONSE.submissionId,
      eventId: RESPONSE.eventId,
    });
  });

  it('keeps the completed record for 24 h even when the in_progress marker was short-lived', async () => {
    const { store, redis } = setup({ inProgressTtlSeconds: 60 });
    await store.claim(WORKSPACE, KEY, HASH_A);
    await store.complete(WORKSPACE, KEY, HASH_A, RESPONSE);
    expect(redis.ttlSeconds(redisKey())).toBe(86_400);
    await vi.advanceTimersByTimeAsync(3_600 * SECOND_MS);
    expect((await store.claim(WORKSPACE, KEY, HASH_A)).status).toBe('completed');
  });

  it('exposes the stored hash on replay so a different payload is detectable (422 path)', async () => {
    const { store } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    await store.complete(WORKSPACE, KEY, HASH_A, RESPONSE);
    const replay = await store.claim(WORKSPACE, KEY, HASH_B);
    expect(replay).toEqual({ status: 'completed', requestHash: HASH_A, response: RESPONSE });
  });

  it('reads back a record that the Upstash client already deserialized into an object', async () => {
    const { store, redis } = setup();
    redis.autoDeserialize = true;
    await store.claim(WORKSPACE, KEY, HASH_A);
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({
      status: 'in_progress',
      requestHash: HASH_A,
    });
    await store.complete(WORKSPACE, KEY, HASH_A, RESPONSE);
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({
      status: 'completed',
      requestHash: HASH_A,
      response: RESPONSE,
    });
  });
});

describe('release', () => {
  it('frees an in_progress claim so the client can retry', async () => {
    const { store } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    await store.release(WORKSPACE, KEY);
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({ status: 'claimed' });
  });

  it('never deletes a completed response', async () => {
    const { store, redis } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    await store.complete(WORKSPACE, KEY, HASH_A, RESPONSE);
    await store.release(WORKSPACE, KEY);
    expect(redis.commands).not.toContain('del');
    expect((await store.claim(WORKSPACE, KEY, HASH_A)).status).toBe('completed');
  });

  it('does nothing for a key that was never claimed', async () => {
    const { store, redis } = setup();
    await store.release(WORKSPACE, KEY);
    expect(redis.commands).toEqual(['get']);
  });
});

describe('unavailable', () => {
  it('claim resolves unavailable when Redis rejects, so the database UNIQUE takes over', async () => {
    const { store, redis, logs } = setup();
    redis.failures.set = 'error';
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({ status: 'unavailable' });
    expect(logs()).toContain('idempotency store unavailable');
    expect(logs()).toContain('"level":"warn"');
  });

  it('claim resolves unavailable when reading the existing record fails', async () => {
    const { store, redis } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    redis.failures.get = 'error';
    expect(await store.claim(WORKSPACE, KEY, HASH_A)).toEqual({ status: 'unavailable' });
  });

  it('claim resolves unavailable when Redis does not answer within 1 second', async () => {
    // arrange
    const { store, redis, logs } = setup();
    redis.failures.set = 'hang';
    // act
    const pending = store.claim(WORKSPACE, KEY, HASH_A);
    await vi.advanceTimersByTimeAsync(999);
    const early = await Promise.race([pending, Promise.resolve('pending' as const)]);
    await vi.advanceTimersByTimeAsync(1);
    // assert
    expect(early).toBe('pending');
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(logs()).toContain('"cause":"timeout"');
  });

  it.each([
    ['text that is not JSON', 'definitely-not-json'],
    ['an unknown state', JSON.stringify({ v: 1, state: 'done', requestHash: HASH_A })],
    [
      'an unexpected extra field',
      JSON.stringify({ v: 1, state: 'in_progress', requestHash: HASH_A, role: 'admin' }),
    ],
    ['an unknown version', JSON.stringify({ v: 2, state: 'in_progress', requestHash: HASH_A })],
    [
      'a completed record without a response',
      JSON.stringify({ v: 1, state: 'completed', requestHash: HASH_A }),
    ],
  ])('claim resolves unavailable for a corrupt record holding %s', async (_label, stored) => {
    const { store, redis, logs } = setup();
    redis.poke(redisKey(), stored);
    expect(await store.claim(WORKSPACE, KEY, HASH_B)).toEqual({ status: 'unavailable' });
    expect(logs()).toContain('"cause":"corrupt_record"');
  });

  it('complete never throws when Redis fails or hangs', async () => {
    const { store, redis, logs } = setup();
    redis.failures.set = 'error';
    await expect(store.complete(WORKSPACE, KEY, HASH_A, RESPONSE)).resolves.toBeUndefined();
    redis.failures.set = 'hang';
    const pending = store.complete(WORKSPACE, KEY, HASH_A, RESPONSE);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    expect(logs()).toContain('"operation":"complete"');
  });

  it('release never throws when Redis fails or hangs', async () => {
    const { store, redis, logs } = setup();
    await store.claim(WORKSPACE, KEY, HASH_A);
    redis.failures.get = 'error';
    await expect(store.release(WORKSPACE, KEY)).resolves.toBeUndefined();
    redis.failures.get = 'hang';
    const pending = store.release(WORKSPACE, KEY);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    expect(logs()).toContain('"operation":"release"');
  });

  it('keeps Redis error text and identifiers out of the logs', async () => {
    const { store, redis, logs } = setup();
    redis.failures.set = 'error';
    redis.failures.get = 'error';
    await store.claim(WORKSPACE, KEY, HASH_A);
    await store.complete(WORKSPACE, KEY, HASH_A, RESPONSE);
    await store.release(WORKSPACE, KEY);
    const output = logs();
    expect(output.length).toBeGreaterThan(0);
    for (const sensitive of ['ECONNREFUSED', KEY, WORKSPACE, HASH_A, RESPONSE.submissionId]) {
      expect(output).not.toContain(sensitive);
    }
  });
});
