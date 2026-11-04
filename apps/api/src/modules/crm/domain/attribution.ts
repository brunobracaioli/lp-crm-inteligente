import type { AttributionSnapshot } from '#/shared/lead-profile.ts';

/** A lead keeps two attribution snapshots (crm §3, R5): the first touch is write-once. */
export interface Attribution {
  readonly firstTouch: AttributionSnapshot;
  readonly lastTouch: AttributionSnapshot;
}

export const EMPTY_ATTRIBUTION: AttributionSnapshot = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  utmId: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
  fbclid: null,
  ttclid: null,
  msclkid: null,
  fbp: null,
  fbc: null,
  gaClientId: null,
  landingPageUrl: null,
  referrerUrl: null,
};

/** First submission: the same touch is both first and last. */
export function startAttribution(touch: AttributionSnapshot): Attribution {
  return { firstTouch: touch, lastTouch: touch };
}

/** Later submissions: `first_touch` is preserved, `last_touch` is replaced (R5). */
export function recordTouch(attribution: Attribution, touch: AttributionSnapshot): Attribution {
  return { firstTouch: attribution.firstTouch, lastTouch: touch };
}

/** Paid-media click identifiers that signal purchase intent (crm §5: gclid/gbraid/wbraid/fbclid). */
export function hasPaidClickId(touch: AttributionSnapshot): boolean {
  return [touch.gclid, touch.gbraid, touch.wbraid, touch.fbclid].some(
    (clickId) => clickId !== null && clickId !== '',
  );
}

/** True when the lead came from paid media on its first or its latest touch. */
export function hasPaidOrigin(attribution: Attribution): boolean {
  return hasPaidClickId(attribution.firstTouch) || hasPaidClickId(attribution.lastTouch);
}
