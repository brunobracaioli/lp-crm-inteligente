import { describe, expect, it } from 'vitest';
import { MAX_OUTBOX_ATTEMPTS, retryDelayMs } from '#/modules/tracking/domain/retry-policy.ts';

const FIFTEEN_MINUTES_MS = 15 * 60_000;

describe('retryDelayMs', () => {
  it('doubles the ceiling per attempt', () => {
    expect(retryDelayMs(1, 1)).toBe(30_000);
    expect(retryDelayMs(2, 1)).toBe(60_000);
    expect(retryDelayMs(3, 1)).toBe(120_000);
  });

  it('keeps at least half of the ceiling so jitter never collapses the delay', () => {
    expect(retryDelayMs(1, 0)).toBe(15_000);
    expect(retryDelayMs(4, 0)).toBe(120_000);
  });

  it('is capped at 15 minutes', () => {
    expect(retryDelayMs(MAX_OUTBOX_ATTEMPTS, 1)).toBe(FIFTEEN_MINUTES_MS);
    expect(retryDelayMs(1_000, 1)).toBe(FIFTEEN_MINUTES_MS);
  });

  it('stays inside [ceiling / 2, ceiling] for any random draw', () => {
    for (const random of [0, 0.25, 0.5, 0.999]) {
      const delay = retryDelayMs(3, random);
      expect(delay).toBeGreaterThanOrEqual(60_000);
      expect(delay).toBeLessThanOrEqual(120_000);
    }
  });

  it('treats attempt 0 like the first attempt', () => {
    expect(retryDelayMs(0, 1)).toBe(30_000);
  });
});
