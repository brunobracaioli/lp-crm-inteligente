import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Delivery,
  MAX_DELIVERY_ATTEMPTS,
  type AttemptOutcome,
} from '#/modules/tracking/domain/delivery.ts';
import type { OutboxEventId } from '#/shared/ids.ts';

const OUTBOX_EVENT_ID = '0192f3a0-1111-7222-8333-444455556666' as OutboxEventId;
const T0 = new Date('2026-11-03T12:00:00.000Z');
const T1 = new Date('2026-11-03T12:00:05.000Z');

const SENT: AttemptOutcome = { status: 'sent', httpStatus: 200, externalRef: 'trace-1' };
const RETRYABLE: AttemptOutcome = {
  status: 'retryable_failure',
  httpStatus: 500,
  errorCode: 'meta_server_error',
};
const PERMANENT: AttemptOutcome = {
  status: 'permanent_failure',
  httpStatus: 400,
  errorCode: 'meta_rejected',
};

function openDelivery(): Delivery {
  return Delivery.open(OUTBOX_EVENT_ID, 'meta_capi', T0);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`unexpected transition error: ${result.error}`);
  return result.value;
}

describe('Delivery', () => {
  it('starts pending, open and with zero attempts', () => {
    const delivery = openDelivery();

    expect(delivery).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastHttpStatus: null,
      lastErrorCode: null,
      externalRef: null,
    });
    expect(delivery.isOpen).toBe(true);
    expect(delivery.awaitsRetry).toBe(false);
  });

  it('records a successful attempt with the external reference and closes the delivery', () => {
    const sent = unwrap(openDelivery().recordAttempt(SENT, T1));

    expect(sent).toMatchObject({
      status: 'sent',
      attempts: 1,
      lastHttpStatus: 200,
      lastErrorCode: null,
      externalRef: 'trace-1',
      updatedAt: T1,
    });
    expect(sent.isOpen).toBe(false);
  });

  it('keeps a retryable failure as failed, increments attempts and asks for a retry', () => {
    const failed = unwrap(openDelivery().recordAttempt(RETRYABLE, T1));

    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastHttpStatus: 500,
      lastErrorCode: 'meta_server_error',
    });
    expect(failed.isOpen).toBe(true);
    expect(failed.awaitsRetry).toBe(true);
  });

  it('turns a permanent failure into dead at once, without further retries', () => {
    const dead = unwrap(openDelivery().recordAttempt(PERMANENT, T1));

    expect(dead).toMatchObject({ status: 'dead', attempts: 1, lastErrorCode: 'meta_rejected' });
    expect(dead.isOpen).toBe(false);
    expect(dead.awaitsRetry).toBe(false);
  });

  it('becomes dead when retryable failures exhaust the attempt budget', () => {
    let delivery = openDelivery();
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      delivery = unwrap(delivery.recordAttempt(RETRYABLE, T1));
      expect(delivery.status).toBe('failed');
    }

    const last = unwrap(delivery.recordAttempt(RETRYABLE, T1));

    expect(last).toMatchObject({ status: 'dead', attempts: MAX_DELIVERY_ATTEMPTS });
    expect(last.lastErrorCode).toBe('meta_server_error');
  });

  it('can still succeed after earlier failures', () => {
    const failed = unwrap(openDelivery().recordAttempt(RETRYABLE, T1));
    const sent = unwrap(failed.recordAttempt(SENT, T1));

    expect(sent).toMatchObject({ status: 'sent', attempts: 2, lastErrorCode: null });
  });

  it('skips for missing consent or disabled destination without counting an attempt', () => {
    const noConsent = unwrap(openDelivery().skipForMissingConsent(T1));
    const disabled = unwrap(openDelivery().skipAsDisabled(T1));

    expect(noConsent).toMatchObject({ status: 'skipped_no_consent', attempts: 0 });
    expect(disabled).toMatchObject({ status: 'skipped_disabled', attempts: 0 });
    expect(noConsent.isOpen).toBe(false);
  });

  it('never changes after reaching a terminal status (reprocessing is a no-op)', () => {
    const terminals = [
      unwrap(openDelivery().recordAttempt(SENT, T1)),
      unwrap(openDelivery().recordAttempt(PERMANENT, T1)),
      unwrap(openDelivery().skipForMissingConsent(T1)),
      unwrap(openDelivery().skipAsDisabled(T1)),
    ];

    for (const terminal of terminals) {
      expect(terminal.recordAttempt(SENT, T1)).toEqual({ ok: false, error: 'already_terminal' });
      expect(terminal.recordAttempt(RETRYABLE, T1)).toEqual({
        ok: false,
        error: 'already_terminal',
      });
      expect(terminal.skipForMissingConsent(T1)).toEqual({ ok: false, error: 'already_terminal' });
      expect(terminal.skipAsDisabled(T1)).toEqual({ ok: false, error: 'already_terminal' });
    }
  });

  it('does not mutate the previous instance', () => {
    const original = openDelivery();
    unwrap(original.recordAttempt(SENT, T1));

    expect(original.status).toBe('pending');
    expect(original.attempts).toBe(0);
  });

  it('round-trips through snapshot and rehydrate', () => {
    const failed = unwrap(openDelivery().recordAttempt(RETRYABLE, T1));

    expect(Delivery.rehydrate(failed.snapshot())).toEqual(failed);
  });

  it('keeps attempts monotonic and never leaves a terminal status, for any outcome sequence', () => {
    const outcome = fc.constantFrom(SENT, RETRYABLE, PERMANENT);
    fc.assert(
      fc.property(fc.array(outcome, { maxLength: 20 }), (outcomes) => {
        let delivery = openDelivery();
        let reachedTerminal = false;
        for (const next of outcomes) {
          const result = delivery.recordAttempt(next, T1);
          if (reachedTerminal) {
            expect(result.ok).toBe(false);
            continue;
          }
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.attempts).toBe(delivery.attempts + 1);
            delivery = result.value;
            reachedTerminal = !delivery.isOpen;
          }
        }
        expect(delivery.attempts).toBeLessThanOrEqual(MAX_DELIVERY_ATTEMPTS);
      }),
    );
  });
});
