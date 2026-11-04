import type { CommandResult } from '#/modules/crm/application/commands/failures.ts';
import type {
  IdempotencyScope,
  StaffIdempotencyStore,
  StoredOutcome,
} from '#/modules/crm/application/commands/ports.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';
import { err, ok } from '#/shared/result.ts';

/** `Retry-After` of a request whose twin is still running. */
export const IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS = 1;

/** JSON with object keys sorted at every depth: equal intents hash equally whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** The stored outcome and the value the caller answers with, produced together by one execution. */
export interface Executed<V> {
  readonly value: V;
  readonly outcome: StoredOutcome;
}

export interface IdempotencyPolicy<V> {
  readonly store: StaffIdempotencyStore;
  /** Null when the request has no key, or its body cannot be fingerprinted: no replay protection. */
  readonly scope: IdempotencyScope | null;
  /** SHA-256 of the operation and the canonical body; compared against the stored one. */
  readonly requestHash: string;
  /** When true a store outage refuses the request; when false the request runs unprotected. */
  readonly storeRequired: boolean;
  /** Rebuilds the answer of a completed request; `undefined` when its resource is gone. */
  readonly replay: (outcome: StoredOutcome) => Promise<V | undefined>;
}

export function requestHashOf(operation: string, body: unknown): string {
  return sha256Hex(`${operation}\n${canonicalJson(body)}`);
}

/**
 * Executes `execute` at most once per idempotency key: a completed twin is answered from its stored
 * outcome, a running twin is `409 idempotency_in_progress`, the same key with another body is
 * `422 idempotency_key_reused`. Only successes are remembered; every failure releases the claim so
 * the client may retry. The store keeps references, never bodies (no PII in Redis).
 */
export async function runIdempotent<V>(
  policy: IdempotencyPolicy<V>,
  execute: () => Promise<CommandResult<Executed<V>>>,
): Promise<CommandResult<V>> {
  const { scope } = policy;
  if (scope === null) {
    return unwrapExecuted(await execute());
  }
  const claim = await policy.store.claim(scope, policy.requestHash);
  switch (claim.status) {
    case 'unavailable':
      return policy.storeRequired
        ? err({ code: 'idempotency_unavailable' })
        : unwrapExecuted(await execute());
    case 'in_progress':
      return claim.requestHash === policy.requestHash
        ? err({
            code: 'idempotency_in_progress',
            retryAfterSeconds: IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS,
          })
        : err({ code: 'idempotency_key_reused' });
    case 'completed': {
      if (claim.requestHash !== policy.requestHash) {
        return err({ code: 'idempotency_key_reused' });
      }
      const replayed = await policy.replay(claim.outcome);
      return replayed === undefined ? unwrapExecuted(await execute()) : ok(replayed);
    }
    case 'claimed':
      break;
  }

  let executed: CommandResult<Executed<V>>;
  try {
    executed = await execute();
  } catch (error) {
    await policy.store.release(scope);
    throw error;
  }
  if (!executed.ok) {
    await policy.store.release(scope);
    return executed;
  }
  await policy.store.complete(scope, policy.requestHash, executed.value.outcome);
  return ok(executed.value.value);
}

function unwrapExecuted<V>(executed: CommandResult<Executed<V>>): CommandResult<V> {
  return executed.ok ? ok(executed.value.value) : executed;
}
