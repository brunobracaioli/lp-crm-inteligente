import { z } from 'zod';
import type {
  AcceptedSubmission,
  IdempotencyClaim,
  IdempotencyStore,
} from '#/modules/lead-capture/application/ports.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { EventId, IdempotencyKey, SubmissionId, WorkspaceId } from '#/shared/ids.ts';

/** lead-capture R7: how long a completed response can be replayed. */
export const IDEMPOTENCY_TTL_SECONDS = 86_400;

/** Outbound Redis timeout (000-overview §5.4), applied to each store operation as a whole. */
export const IDEMPOTENCY_REDIS_TIMEOUT_MS = 1_000;

/** The claim is retried once if the key disappears between SET NX and GET (expiry, release). */
const MAX_CLAIM_ATTEMPTS = 2;
const RECORD_VERSION = 1;
const KEY_ROOT = 'lp:idem:v1';
const MAX_FIELD_LENGTH = 128;

/** The slice of the `@upstash/redis` client this store uses. */
export interface IdempotencyRedis {
  /** `nx: true` resolves to "OK" when written and null when the key already exists. */
  set(
    key: string,
    value: string,
    options: { readonly ex: number; readonly nx?: true },
  ): Promise<unknown>;
  /** The real client auto-deserializes JSON, so this may be a string or an already parsed object. */
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface UpstashIdempotencyStoreDependencies {
  readonly redis: IdempotencyRedis;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /**
   * TTL of the `in_progress` marker. Defaults to {@link IDEMPOTENCY_TTL_SECONDS}, as specified.
   * A marker is only released by a request that ends normally, so a function killed mid-flight
   * leaves it behind until it expires; a short value (> `maxDuration`) bounds that lockout.
   * `complete` always re-writes the record with the full 24 h.
   */
  readonly inProgressTtlSeconds?: number;
}

const hashSchema = z.string().min(1).max(MAX_FIELD_LENGTH);

/** What is persisted. Strict: anything else in that key is corruption or tampering. */
const recordSchema = z.discriminatedUnion('state', [
  z.strictObject({
    v: z.literal(RECORD_VERSION),
    state: z.literal('in_progress'),
    requestHash: hashSchema,
  }),
  z.strictObject({
    v: z.literal(RECORD_VERSION),
    state: z.literal('completed'),
    requestHash: hashSchema,
    submissionId: z.string().min(1).max(MAX_FIELD_LENGTH),
    eventId: z.string().min(1).max(MAX_FIELD_LENGTH),
  }),
]);

type StoredRecord = z.infer<typeof recordSchema>;

type ReadResult =
  | { readonly kind: 'record'; readonly record: StoredRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' };

type Operation = 'claim' | 'complete' | 'release';

/**
 * `IdempotencyStore` backed by Upstash Redis (lead-capture R7, §2 steps 9 and 12).
 *
 * Redis is a fast path, not the source of truth: the `UNIQUE (workspace_id, idempotency_key)`
 * constraint is the second barrier. So every Redis failure degrades to `unavailable` (claim) or is
 * logged and swallowed (complete, release) instead of failing a request that may already be
 * committed. The store never inspects `requestHash`: it hands the stored one back and the use
 * case decides between replay (equal) and 422 (different).
 */
export function createUpstashIdempotencyStore(
  deps: UpstashIdempotencyStoreDependencies,
): IdempotencyStore {
  const timeoutMs = deps.timeoutMs ?? IDEMPOTENCY_REDIS_TIMEOUT_MS;
  const inProgressTtl = deps.inProgressTtlSeconds ?? IDEMPOTENCY_TTL_SECONDS;

  const warn = (operation: Operation, cause: 'error' | 'timeout' | 'corrupt_record'): void => {
    // Only the operation and a coarse cause: Redis errors can echo the failing command.
    deps.logger.warn({ operation, cause }, 'idempotency store unavailable');
  };

  const read = async (redisKey: string): Promise<ReadResult> => {
    const raw = await deps.redis.get(redisKey);
    if (raw === null || raw === undefined) return { kind: 'missing' };
    const parsed = recordSchema.safeParse(decode(raw));
    return parsed.success ? { kind: 'record', record: parsed.data } : { kind: 'corrupt' };
  };

  const claimOnce = async (
    redisKey: string,
    requestHash: string,
  ): Promise<IdempotencyClaim | 'retry'> => {
    const inProgress: StoredRecord = { v: RECORD_VERSION, state: 'in_progress', requestHash };
    const written = await deps.redis.set(redisKey, JSON.stringify(inProgress), {
      nx: true,
      ex: inProgressTtl,
    });
    if (written === 'OK') return { status: 'claimed' };

    const existing = await read(redisKey);
    if (existing.kind === 'missing') return 'retry';
    if (existing.kind === 'corrupt') {
      warn('claim', 'corrupt_record');
      return { status: 'unavailable' };
    }
    return toClaim(existing.record);
  };

  return {
    async claim(workspaceId, key, requestHash) {
      const redisKey = storeKey(workspaceId, key);
      try {
        return await withTimeout(async () => {
          for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
            const result = await claimOnce(redisKey, requestHash);
            if (result !== 'retry') return result;
          }
          return { status: 'unavailable' } as const;
        }, timeoutMs);
      } catch (error) {
        warn('claim', error instanceof RedisTimeoutError ? 'timeout' : 'error');
        return { status: 'unavailable' };
      }
    },

    async complete(workspaceId, key, requestHash, response) {
      const completed: StoredRecord = {
        v: RECORD_VERSION,
        state: 'completed',
        requestHash,
        submissionId: response.submissionId,
        eventId: response.eventId,
      };
      try {
        await withTimeout(
          () =>
            deps.redis.set(storeKey(workspaceId, key), JSON.stringify(completed), {
              ex: IDEMPOTENCY_TTL_SECONDS,
            }),
          timeoutMs,
        );
      } catch (error) {
        warn('complete', error instanceof RedisTimeoutError ? 'timeout' : 'error');
      }
    },

    async release(workspaceId, key) {
      const redisKey = storeKey(workspaceId, key);
      try {
        await withTimeout(async () => {
          const existing = await read(redisKey);
          // Only an in_progress marker is ever released: a completed response must stay replayable.
          if (existing.kind === 'record' && existing.record.state === 'in_progress') {
            await deps.redis.del(redisKey);
          }
        }, timeoutMs);
      } catch (error) {
        warn('release', error instanceof RedisTimeoutError ? 'timeout' : 'error');
      }
    },
  };
}

/** Workspace-partitioned key. Both parts are server-validated UUIDs, never free text. */
function storeKey(workspaceId: WorkspaceId, key: IdempotencyKey): string {
  return `${KEY_ROOT}:${workspaceId}:${key}`;
}

/** Accepts the raw JSON string or the object the Upstash client auto-deserializes it into. */
function decode(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toClaim(record: StoredRecord): IdempotencyClaim {
  if (record.state === 'in_progress') {
    return { status: 'in_progress', requestHash: record.requestHash };
  }
  // The ids were written by this adapter from branded values (see `complete`).
  const response: AcceptedSubmission = {
    submissionId: record.submissionId as SubmissionId,
    eventId: record.eventId as EventId,
  };
  return { status: 'completed', requestHash: record.requestHash, response };
}

class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`redis call exceeded ${timeoutMs} ms`);
    this.name = 'RedisTimeoutError';
  }
}

/** Rejects when `operation` does not settle in time. The timer is always cleared. */
async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RedisTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
