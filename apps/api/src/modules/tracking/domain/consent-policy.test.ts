import { describe, expect, it } from 'vitest';
import { decideConsent, fieldAllowance } from '#/modules/tracking/domain/consent-policy.ts';
import { DESTINATIONS } from '#/modules/tracking/domain/destinations.ts';
import { CONSENT_DENIED, CONSENT_GRANTED } from '#/modules/tracking/domain/lead-facts.fixture.ts';
import type { ConsentState } from '#/shared/consent.ts';

describe('decideConsent', () => {
  it('lets meta_capi and google_ads through only with ad_user_data granted', () => {
    for (const destination of ['meta_capi', 'google_ads'] as const) {
      expect(decideConsent(destination, CONSENT_GRANTED)).toEqual({ allowed: true });
      expect(decideConsent(destination, { ...CONSENT_GRANTED, adUserData: 'denied' })).toEqual({
        allowed: false,
        reason: 'ad_user_data_denied',
      });
    }
  });

  it('does not let analytics_storage or ad_storage substitute for ad_user_data', () => {
    const onlyOthers: ConsentState = {
      ...CONSENT_DENIED,
      analyticsStorage: 'granted',
      adStorage: 'granted',
      adPersonalization: 'granted',
    };
    expect(decideConsent('meta_capi', onlyOthers)).toEqual({
      allowed: false,
      reason: 'ad_user_data_denied',
    });
  });

  it('gates ga4_mp on analytics_storage alone', () => {
    expect(decideConsent('ga4_mp', { ...CONSENT_DENIED, analyticsStorage: 'granted' })).toEqual({
      allowed: true,
    });
    expect(decideConsent('ga4_mp', { ...CONSENT_GRANTED, analyticsStorage: 'denied' })).toEqual({
      allowed: false,
      reason: 'analytics_storage_denied',
    });
  });

  it('does not gate the internal ai_qualification destination on ads signals', () => {
    expect(decideConsent('ai_qualification', CONSENT_DENIED)).toEqual({ allowed: true });
  });

  it('denies every ad destination when everything is denied (absent consent object)', () => {
    for (const destination of ['meta_capi', 'google_ads', 'ga4_mp'] as const) {
      expect(decideConsent(destination, CONSENT_DENIED).allowed).toBe(false);
    }
  });
});

describe('fieldAllowance', () => {
  it('lets meta_capi carry network context and browser ids when ad storage is granted', () => {
    expect(fieldAllowance('meta_capi', CONSENT_GRANTED)).toEqual({
      networkContext: true,
      browserAdIdentifiers: true,
    });
  });

  it('drops fbp/fbc but keeps network context when ad_user_data is granted without ad_storage', () => {
    expect(fieldAllowance('meta_capi', { ...CONSENT_GRANTED, adStorage: 'denied' })).toEqual({
      networkContext: true,
      browserAdIdentifiers: false,
    });
  });

  it('allows no optional field for a denied destination', () => {
    expect(fieldAllowance('meta_capi', CONSENT_DENIED)).toEqual({
      networkContext: false,
      browserAdIdentifiers: false,
    });
  });

  it('never gives non-Meta destinations IP, user agent or Meta browser ids', () => {
    for (const destination of DESTINATIONS.filter((name) => name !== 'meta_capi')) {
      expect(fieldAllowance(destination, CONSENT_GRANTED)).toEqual({
        networkContext: false,
        browserAdIdentifiers: false,
      });
    }
  });
});
