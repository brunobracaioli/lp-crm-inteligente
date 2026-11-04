import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConversionDestination } from '#/modules/tracking/application/ports.ts';
import {
  hashIdentity,
  prepareServerConversion,
} from '#/modules/tracking/application/prepare-server-conversion.ts';
import { Delivery } from '#/modules/tracking/domain/delivery.ts';
import {
  CONSENT_DENIED,
  CONSENT_GRANTED,
  LEAD_ID,
  aLeadFacts,
} from '#/modules/tracking/domain/lead-facts.fixture.ts';
import { normalizeIdentity } from '#/modules/tracking/domain/normalization.ts';
import { MetaCapiClient } from '#/modules/tracking/infrastructure/meta-capi-client.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';
import type { OutboxEventId } from '#/shared/ids.ts';

const OUTBOX_EVENT_ID = '0192f3a0-1111-7222-8333-444455556666' as OutboxEventId;
const NOW = new Date('2026-11-03T12:00:10.000Z');

describe('hashIdentity', () => {
  it('hashes each normalized identifier with SHA-256 hex', () => {
    const identity = normalizeIdentity({
      email: 'John_Smith@gmail.com',
      whatsappE164: '+1 (650) 555-1212',
      firstName: 'Mary',
      lastName: 'Valéry',
      externalId: LEAD_ID,
    });
    if (!identity.ok) throw new Error('fixture must normalize');

    // Digests documented by Meta (see domain/normalization.test.ts for the source and date).
    expect(hashIdentity(identity.value)).toEqual({
      em: '62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f',
      ph: 'e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176',
      fn: '6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec',
      ln: '08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c',
      externalId: sha256Hex(LEAD_ID),
    });
  });
});

describe('prepareServerConversion', () => {
  it('returns a hashed event whose identifiers are 64-char hex and never clear values', () => {
    const prepared = prepareServerConversion(aLeadFacts(), 'meta_capi');

    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') return;
    const { userData } = prepared.event;
    for (const digest of Object.values(userData)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(prepared.event.userData)).not.toContain('maria');
    expect(userData.externalId).toBe(sha256Hex(LEAD_ID));
  });

  it('does not hash anything when consent is denied (gate runs before hashing)', () => {
    const hashed: string[] = [];

    const prepared = prepareServerConversion(
      aLeadFacts({ consent: CONSENT_DENIED }),
      'meta_capi',
      (value) => {
        hashed.push(value);
        return sha256Hex(value);
      },
    );

    expect(prepared).toEqual({
      kind: 'skipped',
      status: 'skipped_no_consent',
      reason: 'ad_user_data_denied',
    });
    expect(hashed).toEqual([]);
  });

  it('reports an invalid source instead of hashing an empty value', () => {
    expect(prepareServerConversion(aLeadFacts({ firstName: '...' }), 'meta_capi')).toEqual({
      kind: 'invalid',
      error: 'empty_first_name',
    });
  });

  it('carries no browser or network ids when ad_storage is denied', () => {
    const prepared = prepareServerConversion(
      aLeadFacts({ consent: { ...CONSENT_GRANTED, adStorage: 'denied' } }),
      'meta_capi',
    );

    expect(prepared.kind === 'ready' && prepared.event).toMatchObject({
      fbp: null,
      fbc: null,
      clientIpAddress: '203.0.113.7',
    });
  });
});

describe('AC-TR-02 denied consent never reaches Meta', () => {
  const server = setupServer();
  const outboundRequests: string[] = [];

  beforeAll(() => {
    // 'error' also makes any unmocked call fail loudly: there is deliberately no Meta handler.
    server.listen({ onUnhandledFrame: 'error' });
    server.events.on('request:start', ({ request }) => {
      outboundRequests.push(request.url);
    });
  });
  beforeEach(() => {
    outboundRequests.length = 0;
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });

  /** The per-destination step of the dispatcher (wave 5b wires the same sequence to the DB). */
  async function deliverOnce(
    delivery: Delivery,
    destination: ConversionDestination,
    consent: typeof CONSENT_DENIED,
  ): Promise<Delivery> {
    const prepared = prepareServerConversion(aLeadFacts({ consent }), destination.name);
    if (prepared.kind === 'skipped') {
      const skipped = delivery.skipForMissingConsent(NOW);
      if (!skipped.ok) throw new Error(skipped.error);
      return skipped.value;
    }
    if (prepared.kind === 'invalid') throw new Error(prepared.error);
    const attempted = delivery.recordAttempt(await destination.send(prepared.event), NOW);
    if (!attempted.ok) throw new Error(attempted.error);
    return attempted.value;
  }

  function metaClient(): MetaCapiClient {
    return new MetaCapiClient(
      { pixelId: '123456789012345', accessToken: 'EAAFake-token', graphApiVersion: 'v25.0' },
      { logger: createLogger({ level: 'silent', appEnv: 'test' }) },
    );
  }

  it('AC-TR-02: ad_user_data=denied yields skipped_no_consent and zero HTTP calls', async () => {
    const delivery = await deliverOnce(
      Delivery.open(OUTBOX_EVENT_ID, 'meta_capi', NOW),
      metaClient(),
      CONSENT_DENIED,
    );

    expect(delivery).toMatchObject({ status: 'skipped_no_consent', attempts: 0 });
    expect(outboundRequests).toEqual([]);
  });

  it('AC-TR-02: ad_user_data=denied is skipped even when every other signal is granted', async () => {
    const delivery = await deliverOnce(
      Delivery.open(OUTBOX_EVENT_ID, 'meta_capi', NOW),
      metaClient(),
      { ...CONSENT_GRANTED, adUserData: 'denied' },
    );

    expect(delivery.status).toBe('skipped_no_consent');
    expect(outboundRequests).toEqual([]);
  });

  it('control: with ad_user_data=granted the same flow does attempt the call (MSW blocks it)', async () => {
    const delivery = await deliverOnce(
      Delivery.open(OUTBOX_EVENT_ID, 'meta_capi', NOW),
      metaClient(),
      CONSENT_GRANTED,
    );

    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toContain('graph.facebook.com');
    // No handler exists, so the call fails as a network error and the delivery is retryable.
    expect(delivery).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCode: 'meta_network',
    });
  });
});
