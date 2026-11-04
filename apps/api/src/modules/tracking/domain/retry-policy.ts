/**
 * Retry and dead-letter timing of the outbox (tracking §5.1). Pure: randomness is injected so the
 * schedule is deterministic in tests.
 */

/** Total dispatch/republish attempts of one outbox event before it is dead-lettered (§5.1). */
export const MAX_OUTBOX_ATTEMPTS = 8;

const MS_PER_MINUTE = 60_000;
const BASE_RETRY_DELAY_MS = 30_000;
/** Capped at three sweeper periods so a stuck event is revisited within a few sweeps. */
const MAX_RETRY_DELAY_MS = 15 * MS_PER_MINUTE;
const GROWTH_FACTOR = 2;
const HALF = 2;

/**
 * Exponential backoff with "equal jitter": the ceiling doubles per attempt (30 s, 60 s, ... capped
 * at 15 min) and the actual delay is drawn uniformly from the upper half of it, so concurrent
 * retries spread out without ever collapsing to zero.
 *
 * @param attempt Attempts already made (>= 1).
 * @param random A value in [0, 1) (`Math.random()` in production).
 */
export function retryDelayMs(attempt: number, random: number): number {
  const exponent = Math.max(0, Math.min(attempt, MAX_OUTBOX_ATTEMPTS) - 1);
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * GROWTH_FACTOR ** exponent);
  const unit = Math.min(Math.max(random, 0), 1);
  return Math.floor(ceiling / HALF + unit * (ceiling / HALF));
}
