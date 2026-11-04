import { describe, expect, it } from 'vitest';
import type { SweepOutboxResult } from '#/modules/tracking/application/sweep-outbox.ts';
import { MAX_OUTBOX_ATTEMPTS } from '#/modules/tracking/domain/retry-policy.ts';
import {
  CORRELATION_ID,
  OTHER_WORKSPACE_ID,
  WORKSPACE_ID,
  createTrackingHarness,
  type TrackingHarness,
} from './fakes/tracking.ts';

const MINUTE_MS = 60_000;
const SWEEP_PERIOD_MS = 5 * MINUTE_MS;
/** AC-TR-07: a pending event is republished within 7 minutes of its creation. */
const MAX_REPUBLISH_DELAY_MS = 7 * MINUTE_MS;

function sweep(harness: TrackingHarness): Promise<SweepOutboxResult> {
  return harness.sweep({ workspaceId: WORKSPACE_ID, correlationId: CORRELATION_ID });
}

function ago(harness: TrackingHarness, ms: number): Date {
  return new Date(harness.clock.now().getTime() - ms);
}

describe('AC-TR-07 orphaned pending events are republished', () => {
  it('AC-TR-07: a pending event older than 2 minutes is republished and counted', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ createdAt: ago(harness, 3 * MINUTE_MS) });

    const result = await sweep(harness);

    expect(result).toEqual({ republished: 1, publishFailures: 0, deadLettered: 0 });
    expect(harness.publisher.published).toEqual([id]);
    expect(harness.publisher.correlationIds).toEqual([CORRELATION_ID]);
    expect(harness.outbox.get(id).attempts).toBe(1);
    expect(harness.outbox.statusOf(id)).toBe('pending');
  });

  it('AC-TR-07: an event created just before a 5-minute schedule tick is republished within 7 minutes', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    const createdAt = harness.clock.now();

    // Worst case: created right after a tick, so the first sweep sees it too young (< 2 min)…
    harness.clock.advance(MINUTE_MS);
    const early = await sweep(harness);
    // …and the next tick, one period later, republishes it.
    harness.clock.advance(SWEEP_PERIOD_MS);
    const next = await sweep(harness);

    expect(early.republished).toBe(0);
    expect(next.republished).toBe(1);
    expect(harness.publisher.published).toEqual([id]);
    expect(harness.clock.now().getTime() - createdAt.getTime()).toBeLessThanOrEqual(
      MAX_REPUBLISH_DELAY_MS,
    );
  });

  it('leaves events younger than 2 minutes to the post-commit publish', async () => {
    const harness = createTrackingHarness();
    harness.seedEvent({ createdAt: ago(harness, MINUTE_MS) });

    const result = await sweep(harness);

    expect(result.republished).toBe(0);
    expect(harness.publisher.published).toEqual([]);
  });

  it('does not republish before next_attempt_at (backoff after a failed dispatch)', async () => {
    const harness = createTrackingHarness();
    harness.seedEvent({
      createdAt: ago(harness, 10 * MINUTE_MS),
      nextAttemptAt: new Date(harness.clock.now().getTime() + MINUTE_MS),
    });

    expect((await sweep(harness)).republished).toBe(0);
  });

  it('republishes a processing event whose lease expired (worker died) but not a live one', async () => {
    const harness = createTrackingHarness();
    const abandoned = harness.seedEvent({
      createdAt: ago(harness, 10 * MINUTE_MS),
      status: 'processing',
      attempts: 1,
      lockedUntil: ago(harness, 1),
    });
    harness.seedEvent({
      createdAt: ago(harness, 10 * MINUTE_MS),
      status: 'processing',
      attempts: 1,
      lockedUntil: new Date(harness.clock.now().getTime() + MINUTE_MS),
    });

    const result = await sweep(harness);

    expect(result.republished).toBe(1);
    expect(harness.publisher.published).toEqual([abandoned]);
  });

  it('never touches done or dead events', async () => {
    const harness = createTrackingHarness();
    harness.seedEvent({ createdAt: ago(harness, 10 * MINUTE_MS), status: 'done' });
    harness.seedEvent({ createdAt: ago(harness, 10 * MINUTE_MS), status: 'dead' });

    expect((await sweep(harness)).republished).toBe(0);
  });

  it('does not see events of another workspace', async () => {
    const harness = createTrackingHarness();
    harness.seedEvent({ createdAt: ago(harness, 10 * MINUTE_MS), workspaceId: OTHER_WORKSPACE_ID });

    expect((await sweep(harness)).republished).toBe(0);
  });
});

describe('sweeper bounds and failure handling', () => {
  it('republishes at most one batch, oldest first', async () => {
    const harness = createTrackingHarness({ batchSize: 2 });
    const oldest = harness.seedEvent({ createdAt: ago(harness, 30 * MINUTE_MS) });
    const middle = harness.seedEvent({ createdAt: ago(harness, 20 * MINUTE_MS) });
    harness.seedEvent({ createdAt: ago(harness, 10 * MINUTE_MS) });

    const result = await sweep(harness);

    expect(result.republished).toBe(2);
    expect(harness.publisher.published).toEqual([oldest, middle]);
  });

  it('keeps going and reports failures when QStash rejects one publish', async () => {
    const harness = createTrackingHarness();
    const failing = harness.seedEvent({ createdAt: ago(harness, 30 * MINUTE_MS) });
    const healthy = harness.seedEvent({ createdAt: ago(harness, 20 * MINUTE_MS) });
    harness.publisher.failing.add(failing);

    const result = await sweep(harness);

    expect(result).toEqual({ republished: 1, publishFailures: 1, deadLettered: 0 });
    expect(harness.publisher.published).toEqual([healthy]);
    expect(harness.outbox.statusOf(failing)).toBe('pending');
    expect(harness.telemetry.anomalies.map((a) => a.code)).toEqual(['republish_failed']);
  });

  it('schedules the next attempt with backoff so the next sweep does not republish it again', async () => {
    const harness = createTrackingHarness({ random: 0 });
    const id = harness.seedEvent({ createdAt: ago(harness, 10 * MINUTE_MS) });

    await sweep(harness);
    const second = await sweep(harness);

    // attempts = 1 → 30 s ceiling, jitter 0 → 15 s in the future.
    expect(harness.outbox.nextAttemptAt(id).getTime() - harness.clock.now().getTime()).toBe(15_000);
    expect(second.republished).toBe(0);
  });

  it('dead-letters an event that used up its attempts instead of republishing it', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({
      createdAt: ago(harness, 60 * MINUTE_MS),
      attempts: MAX_OUTBOX_ATTEMPTS,
    });

    const result = await sweep(harness);

    expect(result).toEqual({ republished: 0, publishFailures: 0, deadLettered: 1 });
    expect(harness.outbox.statusOf(id)).toBe('dead');
    expect(harness.publisher.published).toEqual([]);
    expect(harness.telemetry.dead).toEqual([
      { outboxEventId: id, reason: 'attempts_exhausted', correlationId: CORRELATION_ID },
    ]);
  });

  it('records the lag of each swept event', async () => {
    const harness = createTrackingHarness();
    harness.seedEvent({ createdAt: ago(harness, 10 * MINUTE_MS) });

    await sweep(harness);

    expect(harness.telemetry.lags).toEqual([600]);
  });
});
