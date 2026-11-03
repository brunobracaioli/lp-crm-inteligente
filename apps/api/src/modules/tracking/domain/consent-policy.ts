import type { Destination } from '#/modules/tracking/domain/destinations.ts';
import type { ConsentState } from '#/shared/consent.ts';

/**
 * Which consent signal gates each destination (tracking §4): CAPI and Google Ads need
 * `ad_user_data`, GA4 Measurement Protocol needs `analytics_storage`. The table is exhaustive on
 * purpose: adding a destination without deciding its consent rule is a compile error.
 *
 * `ai_qualification` processes the lead internally (no ad platform receives anything), so it is
 * not gated by an ads/analytics signal; its legal basis belongs to wave 11.
 * `ad_personalization` gates nothing in v1: no server event feeds remarketing audiences.
 */
type GatingSignal = 'adUserData' | 'analyticsStorage';

const GATING_SIGNAL: Readonly<Record<Destination, GatingSignal | null>> = {
  meta_capi: 'adUserData',
  google_ads: 'adUserData',
  ga4_mp: 'analyticsStorage',
  ai_qualification: null,
};

export type ConsentDenialReason = 'ad_user_data_denied' | 'analytics_storage_denied';

const DENIAL_REASON: Readonly<Record<GatingSignal, ConsentDenialReason>> = {
  adUserData: 'ad_user_data_denied',
  analyticsStorage: 'analytics_storage_denied',
};

export type ConsentDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: ConsentDenialReason };

/** Whether `destination` may receive anything about a submission with this consent state. */
export function decideConsent(destination: Destination, consent: ConsentState): ConsentDecision {
  const signal = GATING_SIGNAL[destination];
  if (signal === null || consent[signal] === 'granted') {
    return { allowed: true };
  }
  return { allowed: false, reason: DENIAL_REASON[signal] };
}

/**
 * Optional fields a destination may carry once it is allowed. Hashed identifiers are always part
 * of an allowed conversion (the port requires them); the rest is minimised per consent state.
 */
export interface FieldAllowance {
  /** `client_ip_address` and `client_user_agent`. */
  readonly networkContext: boolean;
  /** `fbp` / `fbc`: identifiers derived from ad storage (the `_fbp`/`_fbc` cookies and fbclid). */
  readonly browserAdIdentifiers: boolean;
}

const NO_OPTIONAL_FIELDS: FieldAllowance = {
  networkContext: false,
  browserAdIdentifiers: false,
};

/** Optional fields allowed for `destination`; empty whenever the destination itself is denied. */
export function fieldAllowance(destination: Destination, consent: ConsentState): FieldAllowance {
  if (!decideConsent(destination, consent).allowed) {
    return NO_OPTIONAL_FIELDS;
  }
  if (destination === 'meta_capi') {
    return {
      networkContext: true,
      browserAdIdentifiers: consent.adStorage === 'granted',
    };
  }
  return NO_OPTIONAL_FIELDS;
}
