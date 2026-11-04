import type { IdempotencyKey } from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import { IDEMPOTENCY_KEY_PATTERN } from '#/modules/lead-capture/domain/rules.ts';
import {
  submissionFields,
  type SubmissionSnapshot,
} from '#/modules/lead-capture/domain/submission.ts';

/**
 * `Idempotency-Key` header: a UUID v4 or v7 (lead-capture §3). A missing or malformed header is
 * `400 idempotency_key_missing`. The key is lowercased so `A…` and `a…` are the same intent.
 */
export function parseIdempotencyKey(
  header: string | null | undefined,
): Result<IdempotencyKey, 'idempotency_key_missing'> {
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header.trim())) {
    return err('idempotency_key_missing');
  }
  return ok(header.trim().toLowerCase() as IdempotencyKey);
}

/**
 * Canonical form of the normalized payload that the application hashes with SHA-256 (R7).
 * Excludes the Turnstile token (a retry carries a fresh one) and every server-generated value
 * (a missing `event_id` stays `null`), so a retry of the same intent hashes identically while any
 * semantic change — even after normalization — does not. Key order is fixed by construction.
 */
export function canonicalizeForIdempotency(snapshot: SubmissionSnapshot): string {
  const { consent, attribution } = snapshot;
  return JSON.stringify({
    form_key: snapshot.formKey,
    ...submissionFields(snapshot),
    message: snapshot.message,
    consent: {
      analytics_storage: consent.analyticsStorage,
      ad_storage: consent.adStorage,
      ad_user_data: consent.adUserData,
      ad_personalization: consent.adPersonalization,
    },
    tracking: {
      event_id: snapshot.eventId,
      utm_source: attribution.utmSource,
      utm_medium: attribution.utmMedium,
      utm_campaign: attribution.utmCampaign,
      utm_term: attribution.utmTerm,
      utm_content: attribution.utmContent,
      utm_id: attribution.utmId,
      gclid: attribution.gclid,
      gbraid: attribution.gbraid,
      wbraid: attribution.wbraid,
      fbclid: attribution.fbclid,
      ttclid: attribution.ttclid,
      msclkid: attribution.msclkid,
      fbp: attribution.fbp,
      fbc: attribution.fbc,
      ga_client_id: attribution.gaClientId,
      landing_page_url: attribution.landingPageUrl,
      referrer_url: attribution.referrerUrl,
    },
  });
}
