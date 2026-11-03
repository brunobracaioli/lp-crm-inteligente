import type { LeadConversionFacts } from '#/modules/tracking/domain/conversion-event.ts';
import type { ConsentState } from '#/shared/consent.ts';
import type { EventId, LeadId } from '#/shared/ids.ts';

/** Test-only builders (never imported by production code). All values are synthetic. */
export const CONSENT_GRANTED: ConsentState = {
  analyticsStorage: 'granted',
  adStorage: 'granted',
  adUserData: 'granted',
  adPersonalization: 'granted',
};

export const CONSENT_DENIED: ConsentState = {
  analyticsStorage: 'denied',
  adStorage: 'denied',
  adUserData: 'denied',
  adPersonalization: 'denied',
};

export const LEAD_ID = '0192f3a0-aaaa-7bbb-8ccc-123456789abc' as LeadId;
export const EVENT_ID = '3f1c9f4e-6a52-4b1d-9a53-0f6f7c1d2e11' as EventId;

export function aLeadFacts(overrides: Partial<LeadConversionFacts> = {}): LeadConversionFacts {
  return {
    leadId: LEAD_ID,
    eventId: EVENT_ID,
    submissionCreatedAt: new Date('2026-11-03T12:00:00.000Z'),
    email: 'Maria.Souza@Example.com',
    whatsappE164: '+5511987654321',
    firstName: 'Maria',
    lastName: 'Souza',
    clientIp: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) TestAgent/1.0',
    fbp: 'fb.1.1730635200000.1116446470',
    fbc: null,
    fbclid: 'IwAR0TestClickId',
    landingPageUrl: 'https://lp.example.com/oferta?utm_source=meta',
    consent: CONSENT_GRANTED,
    customData: {
      lead_source: 'meta',
      area_of_expertise: 'technology',
      company_size: '11_50',
      score_band: 'A',
    },
    ...overrides,
  };
}
