import { describe, expect, it } from 'vitest';
import type { DispatchOutcome } from '#/modules/tracking/application/dispatch-outbox-event.ts';
import { Delivery } from '#/modules/tracking/domain/delivery.ts';
import {
  aLeadFacts,
  CONSENT_DENIED,
  CONSENT_GRANTED,
  EVENT_ID,
  LEAD_ID,
} from '#/modules/tracking/domain/lead-facts.fixture.ts';
import { MAX_DELIVERY_ATTEMPTS } from '#/modules/tracking/domain/delivery.ts';
import type { OutboxEventId } from '#/shared/ids.ts';
import {
  CORRELATION_ID,
  OTHER_WORKSPACE_ID,
  WORKSPACE_ID,
  createTrackingHarness,
  type TrackingHarness,
} from './fakes/tracking.ts';

const LEASE_MS = 60_000;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function dispatch(harness: TrackingHarness, id: OutboxEventId): Promise<DispatchOutcome> {
  return harness.dispatch({
    workspaceId: WORKSPACE_ID,
    outboxEventId: id,
    correlationId: CORRELATION_ID,
  });
}

function metaDelivery(harness: TrackingHarness, id: OutboxEventId): Delivery {
  const delivery = harness.deliveries
    .forEvent(id)
    .find((candidate) => candidate.destination === 'meta_capi');
  if (delivery === undefined) throw new Error('meta_capi delivery missing');
  return delivery;
}

describe('AC-TR-01 consent granted produces one sent meta_capi delivery', () => {
  it('AC-TR-01: sends the Lead with the submission event_id and records fbtrace_id', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ source: aLeadFacts({ consent: CONSENT_GRANTED }) });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(harness.meta.calls).toBe(1);
    expect(harness.meta.received[0]?.eventId).toBe(EVENT_ID);
    expect(harness.meta.received[0]?.eventName).toBe('Lead');
    const delivery = metaDelivery(harness, id);
    expect(delivery.status).toBe('sent');
    expect(delivery.attempts).toBe(1);
    expect(delivery.externalRef).toBe('fbtrace_fake');
    expect(harness.outbox.statusOf(id)).toBe('done');
    expect(harness.outbox.processedAt(id)).toEqual(harness.clock.now());
  });

  it('never keeps a database transaction open across the outbound call', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    let openDuringSend = -1;
    harness.meta.onSend = () => {
      openDuringSend = harness.registry.openCount;
    };

    await dispatch(harness, id);

    expect(openDuringSend).toBe(0);
  });
});

describe('AC-TR-02 consent denied makes no outbound call', () => {
  it('AC-TR-02: records skipped_no_consent and never calls the destination', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ source: aLeadFacts({ consent: CONSENT_DENIED }) });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(harness.meta.calls).toBe(0);
    expect(metaDelivery(harness, id).status).toBe('skipped_no_consent');
    expect(metaDelivery(harness, id).attempts).toBe(0);
    expect(harness.outbox.statusOf(id)).toBe('done');
  });

  it('AC-TR-02: gates each destination by its own signal (analytics granted, ads denied)', async () => {
    const harness = createTrackingHarness({ destinationNames: ['meta_capi', 'ga4_mp'] });
    const id = harness.seedEvent({
      source: aLeadFacts({
        consent: { ...CONSENT_DENIED, analyticsStorage: 'granted' },
      }),
    });

    await dispatch(harness, id);

    const byDestination = Object.fromEntries(
      harness.deliveries.forEvent(id).map((d) => [d.destination, d.status] as const),
    );
    expect(byDestination).toEqual({ meta_capi: 'skipped_no_consent', ga4_mp: 'sent' });
    expect(harness.destinations.meta_capi?.calls).toBe(0);
    expect(harness.destinations.ga4_mp?.calls).toBe(1);
  });
});

describe('AC-TR-04 reprocessing is idempotent per destination', () => {
  it('AC-TR-04: dispatching the same event three times sends exactly once', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();

    const outcomes = [
      await dispatch(harness, id),
      await dispatch(harness, id),
      await dispatch(harness, id),
    ];

    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      'completed',
      'already_processed',
      'already_processed',
    ]);
    expect(harness.meta.calls).toBe(1);
    expect(harness.deliveries.forEvent(id)).toHaveLength(1);
  });

  it('AC-TR-04: a retry after a partial failure re-sends only the destination that failed', async () => {
    const harness = createTrackingHarness({ destinationNames: ['meta_capi', 'ga4_mp'] });
    const id = harness.seedEvent();
    harness.destinations.ga4_mp?.script.push({
      status: 'retryable_failure',
      httpStatus: 503,
      errorCode: 'http_5xx',
    });

    const first = await dispatch(harness, id);
    harness.clock.advance(LEASE_MS);
    const second = await dispatch(harness, id);

    expect(first).toEqual({ kind: 'retry_later', reason: 'delivery_failed' });
    expect(second).toEqual({ kind: 'completed' });
    expect(harness.destinations.meta_capi?.calls).toBe(1);
    expect(harness.destinations.ga4_mp?.calls).toBe(2);
    expect(harness.deliveries.forEvent(id).map((d) => d.status)).toEqual(['sent', 'sent']);
    expect(harness.deliveries.forEvent(id)).toHaveLength(2);
  });

  it('AC-TR-04: a delivery already sent is not sent again even if the event is still pending', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    const sent = Delivery.open(id, 'meta_capi', harness.clock.now()).recordAttempt(
      { status: 'sent', httpStatus: 200, externalRef: 'fbtrace_prev' },
      harness.clock.now(),
    );
    if (!sent.ok) throw new Error('fixture');
    harness.deliveries.seed(WORKSPACE_ID, sent.value);

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(harness.meta.calls).toBe(0);
    expect(harness.outbox.statusOf(id)).toBe('done');
  });
});

describe('AC-TR-05 failures', () => {
  it('AC-TR-05: a retryable failure keeps the delivery failed, schedules a retry and asks QStash to retry', async () => {
    const harness = createTrackingHarness({ random: 0 });
    const id = harness.seedEvent();
    harness.meta.script.push({
      status: 'retryable_failure',
      httpStatus: 500,
      errorCode: 'http_5xx',
    });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'retry_later', reason: 'delivery_failed' });
    const delivery = metaDelivery(harness, id);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastHttpStatus).toBe(500);
    expect(delivery.lastErrorCode).toBe('http_5xx');
    expect(harness.outbox.statusOf(id)).toBe('pending');
    // attempts = 1 → ceiling 30 s, jitter draw 0 → half of it.
    expect(harness.outbox.nextAttemptAt(id).getTime() - harness.clock.now().getTime()).toBe(15_000);
    expect(harness.outbox.get(id).lockedUntil).toBeNull();
  });

  it('AC-TR-05: a timeout/network failure is retried like a 5xx', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.meta.script.push({
      status: 'retryable_failure',
      httpStatus: null,
      errorCode: 'timeout',
    });

    const outcome = await dispatch(harness, id);

    expect(outcome.kind).toBe('retry_later');
    expect(metaDelivery(harness, id).lastErrorCode).toBe('timeout');
  });

  it('AC-TR-05: a permanent (4xx) failure is dead, answers 200 and is never retried', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.meta.script.push({
      status: 'permanent_failure',
      httpStatus: 400,
      errorCode: 'validation_error',
    });

    const outcome = await dispatch(harness, id);
    const replay = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(replay).toEqual({ kind: 'already_processed' });
    expect(metaDelivery(harness, id).status).toBe('dead');
    expect(harness.meta.calls).toBe(1);
    expect(harness.outbox.statusOf(id)).toBe('dead');
    expect(harness.telemetry.dead).toEqual([
      { outboxEventId: id, reason: 'delivery_dead', correlationId: CORRELATION_ID },
    ]);
  });

  it('AC-TR-05: a delivery that keeps failing becomes dead after the attempt budget', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      harness.meta.script.push({
        status: 'retryable_failure',
        httpStatus: 503,
        errorCode: 'http_5xx',
      });
    }

    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      outcomes.push((await dispatch(harness, id)).kind);
      harness.clock.advance(LEASE_MS);
    }

    expect(outcomes.slice(0, -1).every((kind) => kind === 'retry_later')).toBe(true);
    expect(outcomes.at(-1)).toBe('completed');
    expect(metaDelivery(harness, id).status).toBe('dead');
    expect(metaDelivery(harness, id).attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(harness.outbox.statusOf(id)).toBe('dead');
    expect(harness.meta.calls).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  it('treats a destination that throws as a retryable failure', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.meta.throwOnSend = true;

    const outcome = await dispatch(harness, id);

    expect(outcome.kind).toBe('retry_later');
    expect(metaDelivery(harness, id).lastErrorCode).toBe('destination_threw');
  });
});

describe('AC-TR-06 nothing in clear leaves the system', () => {
  it('AC-TR-06: the event handed to the destination carries only 64-char hex identifiers', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();

    await dispatch(harness, id);

    const event = harness.meta.received[0];
    if (event === undefined) throw new Error('no event sent');
    for (const digest of Object.values(event.userData)) {
      expect(digest).toMatch(HEX_SHA256);
    }
    const serialized = JSON.stringify(event).toLowerCase();
    for (const clear of ['maria', 'souza', '@example.com', '5511987654321', LEAD_ID]) {
      expect(serialized).not.toContain(clear.toLowerCase());
    }
  });

  it('keeps PII out of every telemetry call', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.meta.script.push({
      status: 'retryable_failure',
      httpStatus: 500,
      errorCode: 'http_5xx',
    });

    await dispatch(harness, id);

    const serialized = JSON.stringify(harness.telemetry).toLowerCase();
    expect(serialized).not.toContain('maria');
    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('5511987654321');
  });
});

describe('claiming the event', () => {
  it('answers not_found (and sends nothing) for an unknown event id', async () => {
    const harness = createTrackingHarness();

    const outcome = await dispatch(
      harness,
      '0193aaaa-0000-7000-8000-0000000000ff' as OutboxEventId,
    );

    expect(outcome).toEqual({ kind: 'not_found' });
    expect(harness.telemetry.anomalies.map((a) => a.code)).toEqual(['event_not_found']);
  });

  it('cannot see an event of another workspace (tenant comes from the trusted scope)', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ workspaceId: OTHER_WORKSPACE_ID });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'not_found' });
    expect(harness.meta.calls).toBe(0);
    expect(harness.deliveries.all()).toHaveLength(0);
  });

  it('asks QStash to retry while another transaction holds the row lock (SKIP LOCKED)', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.outbox.lockedByOthers.add(id);

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'retry_later', reason: 'busy' });
    expect(harness.meta.calls).toBe(0);
  });

  it('asks QStash to retry while another worker holds an unexpired lease', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({
      status: 'processing',
      attempts: 1,
      lockedUntil: new Date(harness.clock.now().getTime() + LEASE_MS),
    });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'retry_later', reason: 'busy' });
    expect(harness.meta.calls).toBe(0);
  });

  it('takes over an event whose lease expired (the previous worker died)', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({
      status: 'processing',
      attempts: 1,
      lockedUntil: new Date(harness.clock.now().getTime() - 1),
    });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(harness.outbox.get(id).attempts).toBe(2);
    expect(harness.meta.calls).toBe(1);
  });

  it('records the age of the event as lag', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.clock.advance(7_000);

    await dispatch(harness, id);

    expect(harness.telemetry.lags).toEqual([7]);
  });
});

describe('events that cannot be delivered', () => {
  it('dead-letters an event whose payload is not lead.captured-shaped', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ payload: null });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'dead_lettered' });
    expect(harness.outbox.statusOf(id)).toBe('dead');
    expect(harness.telemetry.dead[0]?.reason).toBe('invalid_payload');
    expect(harness.meta.calls).toBe(0);
  });

  it('dead-letters an event type no destination handles yet (lead.stage_changed)', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ eventType: 'lead.stage_changed' });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'dead_lettered' });
    expect(harness.telemetry.dead[0]?.reason).toBe('unsupported_event');
  });

  it('marks the delivery dead when the lead is gone or anonymized (no PII to send)', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ source: null });

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(harness.meta.calls).toBe(0);
    expect(metaDelivery(harness, id).status).toBe('dead');
    expect(metaDelivery(harness, id).lastErrorCode).toBe('lead_source_unavailable');
  });

  it('marks the delivery dead when the identity cannot be normalized', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent({ source: aLeadFacts({ firstName: '...' }) });

    await dispatch(harness, id);

    expect(harness.meta.calls).toBe(0);
    expect(metaDelivery(harness, id).status).toBe('dead');
    expect(metaDelivery(harness, id).lastErrorCode).toMatch(/^conversion_invalid_/);
  });

  it('skips as disabled an open delivery whose destination was switched off', async () => {
    const harness = createTrackingHarness({ destinationNames: ['meta_capi'] });
    const id = harness.seedEvent();
    harness.deliveries.seed(WORKSPACE_ID, Delivery.open(id, 'ga4_mp', harness.clock.now()));

    const outcome = await dispatch(harness, id);

    expect(outcome).toEqual({ kind: 'completed' });
    const ga4 = harness.deliveries.forEvent(id).find((d) => d.destination === 'ga4_mp');
    expect(ga4?.status).toBe('skipped_disabled');
    expect(harness.meta.calls).toBe(1);
  });

  it('reports a state conflict when another worker already settled the delivery', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.deliveries.rejectSaves = true;

    await dispatch(harness, id);

    expect(harness.telemetry.anomalies.map((a) => a.code)).toContain('delivery_state_conflict');
  });
});

describe('transactionality', () => {
  it('rolls the claim back when loading the source fails, leaving the event retryable', async () => {
    const harness = createTrackingHarness();
    const id = harness.seedEvent();
    harness.unitOfWork.failure = new Error('database down');

    await expect(dispatch(harness, id)).rejects.toThrow('database down');

    expect(harness.outbox.statusOf(id)).toBe('pending');
    expect(harness.meta.calls).toBe(0);
  });
});
