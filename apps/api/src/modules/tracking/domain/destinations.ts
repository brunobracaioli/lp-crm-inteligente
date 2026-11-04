/**
 * Closed vocabularies of the tracking context (tracking §5, database §3.8). `domain/` cannot import
 * the application ports, so these mirror `ConversionDestinationName` / `DeliveryStatus` from
 * `application/ports.ts`; `domain-ports-compat.test.ts` fails the build if the two drift apart.
 */
export const DESTINATIONS = ['meta_capi', 'ga4_mp', 'google_ads', 'ai_qualification'] as const;
export type Destination = (typeof DESTINATIONS)[number];

export const DELIVERY_STATUSES = [
  'pending',
  'sent',
  'skipped_no_consent',
  'skipped_disabled',
  'failed',
  'dead',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
