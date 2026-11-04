import { z } from 'zod';
import type { Logger } from '#/platform/logger/logger.ts';
import type {
  IdempotencyClaim,
  IdempotencyScope,
  StaffIdempotencyStore,
  StoredOutcome,
} from '#/modules/crm/application/commands/ports.ts';

/** `x-idempotency`: a completed request can be replayed for 24 h. */
export const STAFF_IDEMPOTENCY_TTL_SECONDS = 86_400;
/**
 * A request that crashed mid-flight leaves its marker behind; a short lifetime (above the function
 * `maxDuration`) bounds how long the client is locked out of a retry.
 */
export const STAFF_IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS = 60;
export const STAFF_IDEMPOTENCY_REDIS_TIMEOUT_MS = 1_000;

const RECORD_VERSION = 1;
const KEY_ROOT = 'lp:crm:idem:v1';
const MAX_CLAIM_ATTEMPTS = 2;
const MAX_FIELD_LENGTH = 128;

/** The slice of the `@upstash/redis` client this store uses. */
export interface StaffIdempotencyRedis {
  set(
    key: string,
    value: string,
    options: { readonly ex: number; readonly nx?: true },
  ): Promise<unknown>;
  /** The real client auto-deserializes JSON, so this may be a string or an already parsed object. */
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface UpstashStaffIdempotencyStoreDependencies {
  readonly redis: StaffIdempotencyRedis;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

const hash = z.string().min(1).max(MAX_FIELD_LENGTH);
const id = z.string().min(1).max(MAX_FIELD_LENGTH);

const outcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('lead'), leadId: id, version: z.number().int() }),
  z.strictObject({ kind: z.literal('note'), leadId: id, noteId: id }),
  z.strictObject({
    kind: z.literal('anonymized'),
    leadId: id,
    anonymizedAt: id,
    version: z.number().int(),
  }),
]);

/** Strict on purpose: anything else under that key is corruption or tampering. References only. */
const recordSchema = z.discriminatedUnion('state', [
  z.strictObject({
    v: z.literal(RECORD_VERSION),
    state: z.literal('in_progress'),
    requestHash: hash,
  }),
  z.strictObject({
    v: z.literal(RECORD_VERSION),
    state: z.literal('completed'),
    requestHash: hash,
    outcome: outcomeSchema,
  }),
]);

type StoredRecord = z.infer<typeof recordSchema>;
type ReadResult =
  | { readonly kind: 'record'; readonly record: StoredRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' };

type Operation = 'claim' | 'complete' | 'release';

class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`redis call exceeded ${timeoutMs} ms`);
    this.name = 'RedisTimeoutError';
  }
}

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

/** Partitioned by workspace, user, operation and lead: another user's key never replays here. */
function storeKey(scope: IdempotencyScope): string {
  return [
    KEY_ROOT,
    scope.workspaceId,
    scope.userId,
    scope.operation,
    scope.resourceId,
    scope.key,
  ].join(':');
}

function decode(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toClaim(record: StoredRecord): IdempotencyClaim {
  return record.state === 'in_progress'
    ? { status: 'in_progress', requestHash: record.requestHash }
    : {
        status: 'completed',
        requestHash: record.requestHash,
        outcome: record.outcome satisfies StoredOutcome,
      };
}

/**
 * `StaffIdempotencyStore` over Upstash Redis (contract `x-idempotency`). It stores references to
 * what a request produced — never lead data — so no PII sits in Redis for 24 h. Every Redis failure
 * degrades to `unavailable` (claim) or is logged and swallowed (complete, release); the use case
 * decides whether an unprotected request may proceed.
 */
export function createUpstashStaffIdempotencyStore(
  deps: UpstashStaffIdempotencyStoreDependencies,
): StaffIdempotencyStore {
  const timeoutMs = deps.timeoutMs ?? STAFF_IDEMPOTENCY_REDIS_TIMEOUT_MS;

  const warn = (operation: Operation, cause: 'error' | 'timeout' | 'corrupt_record'): void => {
    deps.logger.warn({ operation, cause }, 'staff idempotency store unavailable');
  };
  const causeOf = (error: unknown): 'error' | 'timeout' =>
    error instanceof RedisTimeoutError ? 'timeout' : 'error';

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
    const marker: StoredRecord = { v: RECORD_VERSION, state: 'in_progress', requestHash };
    const written = await deps.redis.set(redisKey, JSON.stringify(marker), {
      nx: true,
      ex: STAFF_IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS,
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
    async claim(scope, requestHash) {
      const redisKey = storeKey(scope);
      try {
        return await withTimeout(async () => {
          for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
            const result = await claimOnce(redisKey, requestHash);
            if (result !== 'retry') return result;
          }
          return { status: 'unavailable' } as const;
        }, timeoutMs);
      } catch (error) {
        warn('claim', causeOf(error));
        return { status: 'unavailable' };
      }
    },

    async complete(scope, requestHash, outcome) {
      const completed: StoredRecord = {
        v: RECORD_VERSION,
        state: 'completed',
        requestHash,
        outcome,
      };
      try {
        await withTimeout(
          () =>
            deps.redis.set(storeKey(scope), JSON.stringify(completed), {
              ex: STAFF_IDEMPOTENCY_TTL_SECONDS,
            }),
          timeoutMs,
        );
      } catch (error) {
        warn('complete', causeOf(error));
      }
    },

    async release(scope) {
      const redisKey = storeKey(scope);
      try {
        await withTimeout(async () => {
          const existing = await read(redisKey);
          // Only an in-progress marker is ever released: a completed response must stay replayable.
          if (existing.kind === 'record' && existing.record.state === 'in_progress') {
            await deps.redis.del(redisKey);
          }
        }, timeoutMs);
      } catch (error) {
        warn('release', causeOf(error));
      }
    },
  };
}
