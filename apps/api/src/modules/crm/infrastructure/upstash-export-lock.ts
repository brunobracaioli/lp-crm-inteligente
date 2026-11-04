import { randomUUID } from 'node:crypto';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import type { ExportLease, ExportLock } from '#/modules/crm/application/commands/ports.ts';

/**
 * Longest an export may hold the lock (a crashed function releases it by expiry). Comfortably above
 * the 10 s function budget so a slow export is never overlapped by a second one.
 */
export const EXPORT_LOCK_TTL_MS = 30_000;
/** Outbound Redis timeout (000-overview §5.4). */
export const EXPORT_LOCK_REDIS_TIMEOUT_MS = 1_000;

const KEY_ROOT = 'lp:crm:export-lock:v1';

/** The slice of the `@upstash/redis` client this lock uses. */
export interface ExportLockRedis {
  /** `nx: true` resolves to "OK" when written and null when the key already exists. */
  set(
    key: string,
    value: string,
    options: { readonly px: number; readonly nx: true },
  ): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface UpstashExportLockDependencies {
  readonly redis: ExportLockRedis;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  /** Token factory; injectable for tests. */
  readonly newToken?: () => string;
}

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

/**
 * One concurrent export per user (`SET key token NX PX ttl`). Fail-closed: when Redis cannot be
 * reached `acquire` rejects with `DependencyUnavailableError('cache')` (→ 503) — the export must
 * never run without its concurrency limit. Releasing is best effort (the TTL covers a lost release).
 */
export function createUpstashExportLock(deps: UpstashExportLockDependencies): ExportLock {
  const timeoutMs = deps.timeoutMs ?? EXPORT_LOCK_REDIS_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? EXPORT_LOCK_TTL_MS;
  const newToken = deps.newToken ?? randomUUID;

  return {
    async acquire(workspaceId: WorkspaceId, userId: UserId): Promise<ExportLease | null> {
      const key = `${KEY_ROOT}:${workspaceId}:${userId}`;
      const token = newToken();
      let written: unknown;
      try {
        written = await withTimeout(
          () => deps.redis.set(key, token, { px: ttlMs, nx: true }),
          timeoutMs,
        );
      } catch (error) {
        deps.logger.warn(
          {
            operation: 'export_lock_acquire',
            cause: error instanceof RedisTimeoutError ? 'timeout' : 'error',
          },
          'export lock unavailable',
        );
        throw new DependencyUnavailableError('cache', { cause: error });
      }
      if (written !== 'OK') {
        return null;
      }
      return {
        async release(): Promise<void> {
          try {
            await withTimeout(async () => {
              // Only our own token is deleted, so a late release cannot free another export's lock.
              if ((await deps.redis.get(key)) === token) {
                await deps.redis.del(key);
              }
            }, timeoutMs);
          } catch (error) {
            deps.logger.warn(
              {
                operation: 'export_lock_release',
                cause: error instanceof RedisTimeoutError ? 'timeout' : 'error',
              },
              'export lock release failed; it expires by TTL',
            );
          }
        },
      };
    },
  };
}
