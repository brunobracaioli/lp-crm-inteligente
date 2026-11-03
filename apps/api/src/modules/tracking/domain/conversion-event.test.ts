import { describe, expect, it } from 'vitest';
import {
  CUSTOM_DATA_KEYS,
  ConversionEvent,
  type ConversionPayload,
} from '#/modules/tracking/domain/conversion-event.ts';
import {
  CONSENT_DENIED,
  CONSENT_GRANTED,
  EVENT_ID,
  LEAD_ID,
  aLeadFacts,
} from '#/modules/tracking/domain/lead-facts.fixture.ts';

function buildEvent(overrides: Parameters<typeof aLeadFacts>[0] = {}): ConversionEvent {
  const result = ConversionEvent.leadCaptured(aLeadFacts(overrides));
  if (!result.ok) throw new Error(`unexpected build error: ${result.error}`);
  return result.value;
}

function payloadFor(
  event: ConversionEvent,
  destination: 'meta_capi' | 'ga4_mp',
): ConversionPayload {
  const projection = event.projectFor(destination);
  if (projection.kind !== 'send') throw new Error('expected a sendable projection');
  return projection.payload;
}

describe('ConversionEvent.leadCaptured', () => {
  it('builds a website Lead keyed by the submission event id and time', () => {
    const event = buildEvent();

    expect(event).toMatchObject({
      eventName: 'Lead',
      actionSource: 'website',
      eventId: EVENT_ID,
      eventSourceUrl: 'https://lp.example.com/oferta?utm_source=meta',
    });
    expect(event.eventTime).toEqual(new Date('2026-11-03T12:00:00.000Z'));
  });

  it('uses the lead id as external_id and normalizes the identifiers', () => {
    const { identity } = buildEvent();

    expect(identity).toEqual({
      email: 'maria.souza@example.com',
      phone: '5511987654321',
      firstName: 'maria',
      lastName: 'souza',
      externalId: LEAD_ID,
    });
  });

  it('assembles fbc from the fbclid when the cookie value is absent', () => {
    expect(buildEvent({ fbc: null, fbclid: 'IwAR0TestClickId' }).fbc).toBe(
      'fb.1.1793707200000.IwAR0TestClickId',
    );
  });

  it('keeps nothing but the allowed, bounded custom_data keys', () => {
    const event = buildEvent({
      customData: {
        lead_source: 'meta',
        score_band: 'B',
        email: 'leak@example.com',
        company_size: 'x'.repeat(101),
        area_of_expertise: '',
      },
    });

    expect(event.customData).toEqual({ lead_source: 'meta', score_band: 'B' });
    expect(
      Object.keys(event.customData).every((key) => CUSTOM_DATA_KEYS.includes(key as never)),
    ).toBe(true);
  });

  it('turns blank optional context into null', () => {
    const event = buildEvent({ clientIp: null, userAgent: '   ', landingPageUrl: '' });

    expect(event).toMatchObject({
      clientIpAddress: null,
      clientUserAgent: null,
      eventSourceUrl: null,
    });
  });

  it.each([
    [{ email: 'not-an-email' }, 'invalid_email'],
    [{ whatsappE164: '+5' }, 'invalid_phone'],
    [{ firstName: '...' }, 'empty_first_name'],
    [{ lastName: '' }, 'empty_last_name'],
    [{ submissionCreatedAt: new Date(Number.NaN) }, 'invalid_event_time'],
  ] as const)('refuses to build for %j (%s)', (overrides, error) => {
    expect(ConversionEvent.leadCaptured(aLeadFacts(overrides))).toEqual({ ok: false, error });
  });
});

describe('ConversionEvent.projectFor', () => {
  it('projects the full meta_capi payload when every signal is granted', () => {
    const payload = payloadFor(buildEvent(), 'meta_capi');

    expect(payload).toMatchObject({
      clientIpAddress: '203.0.113.7',
      clientUserAgent: 'Mozilla/5.0 (X11; Linux x86_64) TestAgent/1.0',
      fbp: 'fb.1.1730635200000.1116446470',
      fbc: 'fb.1.1793707200000.IwAR0TestClickId',
    });
  });

  it('skips with skipped_no_consent when ad_user_data is denied', () => {
    expect(buildEvent({ consent: CONSENT_DENIED }).projectFor('meta_capi')).toEqual({
      kind: 'skip',
      status: 'skipped_no_consent',
      reason: 'ad_user_data_denied',
    });
  });

  it('keeps ip and user agent but drops fbp/fbc without ad_storage', () => {
    const payload = payloadFor(
      buildEvent({ consent: { ...CONSENT_GRANTED, adStorage: 'denied' } }),
      'meta_capi',
    );

    expect(payload.clientIpAddress).toBe('203.0.113.7');
    expect(payload.fbp).toBeNull();
    expect(payload.fbc).toBeNull();
  });

  it('sends ga4_mp no network context nor Meta ids, gated by analytics_storage', () => {
    const allowed = payloadFor(buildEvent(), 'ga4_mp');
    expect(allowed).toMatchObject({
      clientIpAddress: null,
      clientUserAgent: null,
      fbp: null,
      fbc: null,
    });

    const denied = buildEvent({ consent: { ...CONSENT_GRANTED, analyticsStorage: 'denied' } });
    expect(denied.projectFor('ga4_mp')).toEqual({
      kind: 'skip',
      status: 'skipped_no_consent',
      reason: 'analytics_storage_denied',
    });
    expect(denied.projectFor('meta_capi').kind).toBe('send');
  });
});
