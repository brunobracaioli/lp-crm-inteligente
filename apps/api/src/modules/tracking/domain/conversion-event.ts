import type { ConsentState } from '#/shared/consent.ts';
import type { EventId, LeadId } from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import {
  decideConsent,
  fieldAllowance,
  type ConsentDenialReason,
} from '#/modules/tracking/domain/consent-policy.ts';
import type { Destination } from '#/modules/tracking/domain/destinations.ts';
import { resolveFbc, resolveFbp } from '#/modules/tracking/domain/meta-identifiers.ts';
import {
  normalizeIdentity,
  type NormalizationError,
  type NormalizedIdentity,
} from '#/modules/tracking/domain/normalization.ts';

export type ConversionEventName = 'Lead' | 'QualifiedLead' | 'Won';
export type ActionSource = 'website' | 'system_generated';

/**
 * Raw facts the application layer loads from the lead and its submission (structurally the same
 * as `LeadConversionSource` in the ports). PII lives here only on its way to being normalized.
 */
export interface LeadConversionFacts {
  readonly leadId: LeadId;
  readonly eventId: EventId;
  readonly submissionCreatedAt: Date;
  readonly email: string;
  readonly whatsappE164: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly fbclid: string | null;
  readonly landingPageUrl: string | null;
  readonly consent: ConsentState;
  readonly customData: Readonly<Record<string, string>>;
}

export type ConversionBuildError = NormalizationError | 'invalid_event_time';

/** `custom_data` keys that may leave the system (tracking §5.2): codes only, never PII. */
export const CUSTOM_DATA_KEYS = [
  'lead_source',
  'area_of_expertise',
  'company_size',
  'score_band',
] as const;
const MAX_CUSTOM_DATA_VALUE_LENGTH = 100;
const MAX_USER_AGENT_LENGTH = 1000;

/** What a destination is allowed to receive: normalized identifiers (still to be hashed) + context. */
export interface ConversionPayload {
  readonly eventName: ConversionEventName;
  readonly eventTime: Date;
  readonly eventId: EventId;
  readonly actionSource: ActionSource;
  readonly eventSourceUrl: string | null;
  readonly identity: NormalizedIdentity;
  readonly clientIpAddress: string | null;
  readonly clientUserAgent: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly customData: Readonly<Record<string, string>>;
}

export type DestinationProjection =
  | { readonly kind: 'send'; readonly payload: ConversionPayload }
  | {
      readonly kind: 'skip';
      readonly status: 'skipped_no_consent';
      readonly reason: ConsentDenialReason;
    };

function nonBlank(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

function pickCustomData(raw: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const picked: Record<string, string> = {};
  for (const key of CUSTOM_DATA_KEYS) {
    const value = raw[key];
    if (value !== undefined && value !== '' && value.length <= MAX_CUSTOM_DATA_VALUE_LENGTH) {
      picked[key] = value;
    }
  }
  return picked;
}

/**
 * A conversion worth reporting to ad platforms, built once from a captured lead. It owns the
 * consent rule: nothing is projected for a destination the submission did not consent to, and
 * optional fields are minimised per consent state.
 */
export class ConversionEvent {
  readonly eventName: ConversionEventName;
  readonly eventTime: Date;
  readonly eventId: EventId;
  readonly actionSource: ActionSource;
  readonly eventSourceUrl: string | null;
  readonly identity: NormalizedIdentity;
  readonly clientIpAddress: string | null;
  readonly clientUserAgent: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly customData: Readonly<Record<string, string>>;
  readonly consent: ConsentState;

  private constructor(fields: ConversionPayload & { readonly consent: ConsentState }) {
    this.eventName = fields.eventName;
    this.eventTime = fields.eventTime;
    this.eventId = fields.eventId;
    this.actionSource = fields.actionSource;
    this.eventSourceUrl = fields.eventSourceUrl;
    this.identity = fields.identity;
    this.clientIpAddress = fields.clientIpAddress;
    this.clientUserAgent = fields.clientUserAgent;
    this.fbp = fields.fbp;
    this.fbc = fields.fbc;
    this.customData = fields.customData;
    this.consent = fields.consent;
  }

  /** The `Lead` conversion of a just-captured submission (`action_source: website`). */
  static leadCaptured(facts: LeadConversionFacts): Result<ConversionEvent, ConversionBuildError> {
    if (!Number.isFinite(facts.submissionCreatedAt.getTime())) {
      return err('invalid_event_time');
    }
    const identity = normalizeIdentity({
      email: facts.email,
      whatsappE164: facts.whatsappE164,
      firstName: facts.firstName,
      lastName: facts.lastName,
      externalId: facts.leadId,
    });
    if (!identity.ok) return identity;
    return ok(
      new ConversionEvent({
        eventName: 'Lead',
        eventTime: facts.submissionCreatedAt,
        eventId: facts.eventId,
        actionSource: 'website',
        eventSourceUrl: nonBlank(facts.landingPageUrl),
        identity: identity.value,
        clientIpAddress: nonBlank(facts.clientIp),
        clientUserAgent: nonBlank(facts.userAgent)?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
        fbp: resolveFbp(facts.fbp),
        fbc: resolveFbc({
          fbc: facts.fbc,
          fbclid: facts.fbclid,
          observedAt: facts.submissionCreatedAt,
        }),
        customData: pickCustomData(facts.customData),
        consent: facts.consent,
      }),
    );
  }

  /** What `destination` may receive, or the reason it receives nothing (no HTTP call at all). */
  projectFor(destination: Destination): DestinationProjection {
    const decision = decideConsent(destination, this.consent);
    if (!decision.allowed) {
      return { kind: 'skip', status: 'skipped_no_consent', reason: decision.reason };
    }
    const allowance = fieldAllowance(destination, this.consent);
    return {
      kind: 'send',
      payload: {
        eventName: this.eventName,
        eventTime: this.eventTime,
        eventId: this.eventId,
        actionSource: this.actionSource,
        eventSourceUrl: this.eventSourceUrl,
        identity: this.identity,
        clientIpAddress: allowance.networkContext ? this.clientIpAddress : null,
        clientUserAgent: allowance.networkContext ? this.clientUserAgent : null,
        fbp: allowance.browserAdIdentifiers ? this.fbp : null,
        fbc: allowance.browserAdIdentifiers ? this.fbc : null,
        customData: this.customData,
      },
    };
  }
}
