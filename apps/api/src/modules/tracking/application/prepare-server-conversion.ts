import type {
  ConversionDestinationName,
  HashedUserData,
  LeadConversionSource,
  ServerConversionEvent,
} from '#/modules/tracking/application/ports.ts';
import type { ConsentDenialReason } from '#/modules/tracking/domain/consent-policy.ts';
import {
  ConversionEvent,
  type ConversionBuildError,
} from '#/modules/tracking/domain/conversion-event.ts';
import type { NormalizedIdentity } from '#/modules/tracking/domain/normalization.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';

/** Hex digest function; injectable so tests can prove no clear value reaches a destination. */
export type Hasher = (normalizedValue: string) => string;

/** SHA-256 of the already normalized identifiers (tracking §5.2). */
export function hashIdentity(
  identity: NormalizedIdentity,
  hash: Hasher = sha256Hex,
): HashedUserData {
  return {
    em: hash(identity.email),
    ph: hash(identity.phone),
    fn: hash(identity.firstName),
    ln: hash(identity.lastName),
    externalId: hash(identity.externalId),
  };
}

export type ConversionPreparation =
  /** Consent allows the destination: send this event. */
  | { readonly kind: 'ready'; readonly event: ServerConversionEvent }
  /** Consent denied: record the delivery as `skipped_no_consent` and make NO outbound call. */
  | {
      readonly kind: 'skipped';
      readonly status: 'skipped_no_consent';
      readonly reason: ConsentDenialReason;
    }
  /** The source cannot form a valid conversion (e.g. a name that is only punctuation). */
  | { readonly kind: 'invalid'; readonly error: ConversionBuildError };

/**
 * Builds the destination-specific, hashed `Lead` conversion for a captured submission. The consent
 * gate runs BEFORE any hashing, so a denied destination never even sees derived identifiers.
 */
export function prepareServerConversion(
  source: LeadConversionSource,
  destination: ConversionDestinationName,
  hash: Hasher = sha256Hex,
): ConversionPreparation {
  const built = ConversionEvent.leadCaptured(source);
  if (!built.ok) {
    return { kind: 'invalid', error: built.error };
  }
  const projection = built.value.projectFor(destination);
  if (projection.kind === 'skip') {
    return { kind: 'skipped', status: projection.status, reason: projection.reason };
  }
  const { payload } = projection;
  return {
    kind: 'ready',
    event: {
      eventName: payload.eventName,
      eventTime: payload.eventTime,
      eventId: payload.eventId,
      actionSource: payload.actionSource,
      eventSourceUrl: payload.eventSourceUrl,
      userData: hashIdentity(payload.identity, hash),
      clientIpAddress: payload.clientIpAddress,
      clientUserAgent: payload.clientUserAgent,
      fbp: payload.fbp,
      fbc: payload.fbc,
      customData: payload.customData,
    },
  };
}
