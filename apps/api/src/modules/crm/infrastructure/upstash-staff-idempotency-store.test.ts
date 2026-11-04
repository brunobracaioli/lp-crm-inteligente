import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '#/platform/logger/logger.ts';
import type { IdempotencyKey, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { IdempotencyScope } from '#/modules/crm/application/commands/ports.ts';
import {
  createUpstashStaffIdempotencyStore,
  STAFF_IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS,
  STAFF_IDEMPOTENCY_TTL_SECONDS,
  type StaffIdempotencyRedis,
} from '#/modules/crm/infrastructure/upstash-staff-idempotency-store.ts';

const scope: IdempotencyScope = {
  workspaceId: '00000000-0000-7000-8000-00000000a001' as WorkspaceId,
  userId: '00000000-0000-7000-8000-0000000000e2' as UserId,
  operation: 'note',
  resourceId: '00000000-0000-7000-8000-000000000001',
  key: '11111111-1111-4111-8111-111111111111' as IdempotencyKey,
};

class FakeRedis implements StaffIdempotencyRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  failure: Error | null = null;
  /** Hands back an already parsed object, like the real client does for JSON values. */
  parseOnRead = false;

  set(key: string, value: string, options: { ex: number; nx?: true }): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (options.nx === true && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    this.ttls.set(key, options.ex);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const raw = this.values.get(key);
    if (raw === undefined) return Promise.resolve(null);
    return Promise.resolve(this.parseOnRead ? (JSON.parse(raw) as unknown) : raw);
  }

  del(key: string): Promise<unknown> {
    this.values.delete(key);
    return Promise.resolve(1);
  }
}

function build(redis: FakeRedis) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const store = createUpstashStaffIdempotencyStore({
    redis,
    logger: createLogger({ level: 'debug', appEnv: 'test', destination }),
    timeoutMs: 20,
  });
  return { store, lines };
}

describe('createUpstashStaffIdempotencyStore', () => {
  it('claims a new key with a short in-progress TTL, then reports it in progress', async () => {
    const redis = new FakeRedis();
    const { store } = build(redis);

    const first = await store.claim(scope, 'hash-a');
    const second = await store.claim(scope, 'hash-a');

    expect(first).toEqual({ status: 'claimed' });
    expect(second).toEqual({ status: 'in_progress', requestHash: 'hash-a' });
    expect([...redis.ttls.values()]).toEqual([STAFF_IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS]);
  });

  it('replays a completed outcome for 24 h, as references only', async () => {
    const redis = new FakeRedis();
    const { store } = build(redis);
    await store.claim(scope, 'hash-a');

    await store.complete(scope, 'hash-a', { kind: 'note', leadId: 'lead-1', noteId: 'note-1' });
    const replay = await store.claim(scope, 'hash-a');

    expect(replay).toEqual({
      status: 'completed',
      requestHash: 'hash-a',
      outcome: { kind: 'note', leadId: 'lead-1', noteId: 'note-1' },
    });
    expect([...redis.ttls.values()]).toEqual([STAFF_IDEMPOTENCY_TTL_SECONDS]);
    expect([...redis.values.values()].join()).not.toMatch(/body|email|first_name/);
  });

  it('hands back the stored hash so the use case can tell a replay from a reuse', async () => {
    const redis = new FakeRedis();
    const { store } = build(redis);
    await store.claim(scope, 'hash-a');

    const other = await store.claim(scope, 'hash-b');

    expect(other).toEqual({ status: 'in_progress', requestHash: 'hash-a' });
  });

  it('reads records the client already parsed', async () => {
    const redis = new FakeRedis();
    redis.parseOnRead = true;
    const { store } = build(redis);
    await store.claim(scope, 'hash-a');
    await store.complete(scope, 'hash-a', {
      kind: 'anonymized',
      leadId: 'lead-1',
      anonymizedAt: '2026-11-04T00:00:00.000Z',
      version: 4,
    });

    expect(await store.claim(scope, 'hash-a')).toMatchObject({ status: 'completed' });
  });

  it('partitions by user, operation and resource', async () => {
    const redis = new FakeRedis();
    const { store } = build(redis);
    await store.claim(scope, 'hash-a');

    const otherUser = await store.claim(
      { ...scope, userId: '00000000-0000-7000-8000-0000000000e3' as UserId },
      'hash-a',
    );
    const otherOperation = await store.claim({ ...scope, operation: 'stage' }, 'hash-a');
    const otherLead = await store.claim({ ...scope, resourceId: 'lead-2' }, 'hash-a');

    expect([otherUser, otherOperation, otherLead]).toEqual([
      { status: 'claimed' },
      { status: 'claimed' },
      { status: 'claimed' },
    ]);
  });

  it('releases only in-progress markers', async () => {
    const redis = new FakeRedis();
    const { store } = build(redis);
    await store.claim(scope, 'hash-a');
    await store.release(scope);
    expect(await store.claim(scope, 'hash-a')).toEqual({ status: 'claimed' });

    await store.complete(scope, 'hash-a', { kind: 'lead', leadId: 'lead-1', version: 4 });
    await store.release(scope);

    expect(await store.claim(scope, 'hash-a')).toMatchObject({ status: 'completed' });
  });

  it('reports unavailable on a Redis failure or a corrupt record, never throws, never logs details', async () => {
    const redis = new FakeRedis();
    const { store, lines } = build(redis);
    redis.failure = new Error('secret-detail');
    expect(await store.claim(scope, 'hash-a')).toEqual({ status: 'unavailable' });
    await expect(
      store.complete(scope, 'hash-a', { kind: 'lead', leadId: 'x', version: 1 }),
    ).resolves.toBeUndefined();
    await expect(store.release(scope)).resolves.toBeUndefined();
    redis.failure = null;

    redis.values.set(
      [
        'lp:crm:idem:v1',
        scope.workspaceId,
        scope.userId,
        scope.operation,
        scope.resourceId,
        scope.key,
      ].join(':'),
      '{"v":1,"state":"completed","requestHash":"h","outcome":{"kind":"lead","leadId":"x","version":1,"extra":1}}',
    );
    expect(await store.claim(scope, 'hash-a')).toEqual({ status: 'unavailable' });
    expect(lines.join('')).not.toContain('secret-detail');
  });
});
