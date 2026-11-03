/**
 * Ports of the `tracking` application layer (tracking §5–6). FROZEN in Onda 0 so Onda 5a
 * (domain + HTTP clients, no wiring) runs in parallel with Onda 4. Repositories for the outbox
 * and deliveries are added by Onda 5b (main session), which owns the wiring.
 */
import type { ConsentState } from '#/shared/consent.ts';
import type { CorrelationId, EventId, LeadId, OutboxEventId } from '#/shared/ids.ts';

export type { Clock } from '#/shared/time.ts';

export type ConversionDestinationName = 'meta_capi' | 'ga4_mp' | 'google_ads' | 'ai_qualification';

export type DeliveryStatus =
  'pending' | 'sent' | 'skipped_no_consent' | 'skipped_disabled' | 'failed' | 'dead';

/**
 * Raw facts needed to build a server-side conversion, loaded by Onda 5b from the lead and its
 * submission. PII lives here only in memory, on the way to being normalized and hashed.
 */
export interface LeadConversionSource {
  readonly leadId: LeadId;
  readonly eventId: EventId;
  readonly submissionCreatedAt: Date;
  readonly email: string;
  readonly whatsappE164: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Null after the 30-day purge. */
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly fbclid: string | null;
  readonly landingPageUrl: string | null;
  readonly consent: ConsentState;
  /** Codes only: lead_source, area_of_expertise, company_size, score_band. */
  readonly customData: Readonly<Record<string, string>>;
}

/** user_data fields as lowercase hex SHA-256 (64 chars) of normalized values (tracking §5.2). */
export interface HashedUserData {
  readonly em: string;
  readonly ph: string;
  readonly fn: string;
  readonly ln: string;
  readonly externalId: string;
}

/** Destination-agnostic conversion built by the domain; adapters translate it to each API. */
export interface ServerConversionEvent {
  readonly eventName: 'Lead' | 'QualifiedLead' | 'Won';
  readonly eventTime: Date;
  readonly eventId: EventId;
  readonly actionSource: 'website' | 'system_generated';
  readonly eventSourceUrl: string | null;
  readonly userData: HashedUserData;
  readonly clientIpAddress: string | null;
  readonly clientUserAgent: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly customData: Readonly<Record<string, string>>;
}

export type DeliveryAttemptResult =
  | { readonly status: 'sent'; readonly httpStatus: number; readonly externalRef: string | null }
  /** 429 / 5xx / timeout / network: QStash retries. */
  | {
      readonly status: 'retryable_failure';
      readonly httpStatus: number | null;
      readonly errorCode: string;
    }
  /** 4xx validation: marked `dead`, never retried. `errorCode` is internal, never the body. */
  | {
      readonly status: 'permanent_failure';
      readonly httpStatus: number | null;
      readonly errorCode: string;
    };

export interface ConversionDestination {
  readonly name: ConversionDestinationName;
  send(event: ServerConversionEvent): Promise<DeliveryAttemptResult>;
}

export interface OutboxPublisher {
  /** QStash publishJSON to /internal/v1/outbox/dispatch, deduplicationId = outboxEventId. */
  publish(
    outboxEventId: OutboxEventId,
    options: { readonly correlationId: CorrelationId },
  ): Promise<void>;
}

export interface SignatureVerificationRequest {
  /** Value of the `Upstash-Signature` header, or null when absent. */
  readonly signature: string | null;
  /** Raw request body exactly as received (the JWT carries its hash). */
  readonly rawBody: string;
  /** Absolute URL the request was sent to (must equal the JWT `sub`). */
  readonly url: string;
}

export interface SignatureVerifier {
  /** Checks iss, sub, exp/nbf and body hash with the current OR next signing key. */
  verify(request: SignatureVerificationRequest): Promise<boolean>;
}
