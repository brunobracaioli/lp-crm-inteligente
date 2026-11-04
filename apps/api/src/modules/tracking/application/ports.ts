/**
 * Ports of the `tracking` application layer (tracking §5–6). FROZEN in Onda 0 so Onda 5a
 * (domain + HTTP clients, no wiring) runs in parallel with Onda 4. Repositories for the outbox
 * and deliveries are added by Onda 5b (main session), which owns the wiring.
 */
import type { Delivery } from '#/modules/tracking/domain/delivery.ts';
import type { Destination } from '#/modules/tracking/domain/destinations.ts';
import type { LeadCapturedPayload, OutboxEventType } from '#/modules/tracking/public-api.ts';
import type { ConsentState } from '#/shared/consent.ts';
import type { CorrelationId, EventId, LeadId, OutboxEventId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

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

// ---------------------------------------------------------------------------
// Onda 5b — persistence and observability ports (additive: nothing above changed).

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'dead';

/** A row of tracking.outbox_events as the dispatcher and the sweeper see it. */
export interface OutboxEventRecord {
  readonly id: OutboxEventId;
  readonly workspaceId: WorkspaceId;
  readonly eventType: OutboxEventType;
  /** Null when the stored payload is not the `{lead_id, submission_id}` shape of `lead.captured`. */
  readonly payload: LeadCapturedPayload | null;
  readonly status: OutboxStatus;
  /** Dispatch + republish attempts so far (§5.1: dead-lettered after 8). */
  readonly attempts: number;
  /** Lease of the worker that claimed the event; null when nobody holds it. */
  readonly lockedUntil: Date | null;
  readonly createdAt: Date;
}

/** `busy`: the row exists but another transaction holds its lock (FOR UPDATE SKIP LOCKED). */
export type OutboxLockResult =
  | { readonly kind: 'locked'; readonly event: OutboxEventRecord }
  | { readonly kind: 'busy' }
  | { readonly kind: 'not_found' };

export interface StaleOutboxQuery {
  readonly now: Date;
  /** Only events created before this instant (tracking §5.1: older than 2 minutes). */
  readonly createdBefore: Date;
  readonly limit: number;
}

/** All methods run inside the caller's transaction, scoped to one workspace by RLS. */
export interface OutboxRepository {
  /** `SELECT ... FOR UPDATE SKIP LOCKED` by id. */
  lockById(tx: Transaction, id: OutboxEventId): Promise<OutboxLockResult>;
  /** status = processing, attempts + 1, lease until `lockedUntil`. */
  markProcessing(tx: Transaction, id: OutboxEventId, lockedUntil: Date): Promise<void>;
  /** Back to `pending` with the lease cleared; the sweeper retries it from `nextAttemptAt`. */
  release(tx: Transaction, id: OutboxEventId, nextAttemptAt: Date): Promise<void>;
  /** Terminal state: `done` (all deliveries settled) or `dead` (dead-lettered). */
  complete(
    tx: Transaction,
    id: OutboxEventId,
    result: { readonly status: 'done' | 'dead'; readonly processedAt: Date },
  ): Promise<void>;
  /** Sweeper accounting: attempts + 1, back to `pending`, lease cleared, next attempt scheduled. */
  recordRepublish(tx: Transaction, id: OutboxEventId, nextAttemptAt: Date): Promise<void>;
  /**
   * Events a sweeper must revisit, oldest first, locked with `FOR UPDATE SKIP LOCKED`: `pending`
   * and due (`next_attempt_at <= now`) or `processing` with an expired lease.
   */
  listStale(tx: Transaction, query: StaleOutboxQuery): Promise<readonly OutboxEventRecord[]>;
}

export interface DeliveryRepository {
  /** Creates the missing deliveries (`UNIQUE (outbox_event_id, destination)`, ON CONFLICT DO NOTHING). */
  ensureOpen(
    tx: Transaction,
    workspaceId: WorkspaceId,
    outboxEventId: OutboxEventId,
    destinations: readonly Destination[],
  ): Promise<void>;
  listForEvent(tx: Transaction, outboxEventId: OutboxEventId): Promise<readonly Delivery[]>;
  /**
   * Persists a transition. Only a delivery still `pending`/`failed` in storage is updated; returns
   * false when it was already terminal (a concurrent worker settled it first).
   */
  save(tx: Transaction, delivery: Delivery): Promise<boolean>;
}

/**
 * Reads the facts of a conversion. The implementation reads `crm.leads` and `capture.submissions`
 * (see the boundary note in `infrastructure/postgres-lead-conversion-source-reader.ts`).
 */
export interface LeadConversionSourceReader {
  /** Null when the lead or submission does not exist in the workspace, or the lead was anonymized. */
  load(
    tx: Transaction,
    workspaceId: WorkspaceId,
    payload: LeadCapturedPayload,
  ): Promise<LeadConversionSource | null>;
}

export type OutboxDeadReason =
  'attempts_exhausted' | 'unsupported_event' | 'invalid_payload' | 'delivery_dead';

export type TrackingAnomalyCode =
  'event_not_found' | 'event_busy' | 'delivery_state_conflict' | 'republish_failed';

/**
 * Logs and metrics of the tracking use cases (application cannot import `#/platform`). Every
 * argument is an ID or a closed code: never PII, a token or a third-party response body.
 */
export interface TrackingTelemetry {
  /** One delivery moved to `status` (metric `delivery.result`). */
  deliveryRecorded(event: {
    readonly outboxEventId: OutboxEventId;
    readonly destination: ConversionDestinationName;
    readonly status: DeliveryStatus;
    readonly attempts: number;
    readonly httpStatus: number | null;
    readonly errorCode: string | null;
    readonly correlationId: CorrelationId;
  }): void;
  /** Age of an outbox event when it is picked up (metric `outbox.lag_s`). */
  outboxLag(seconds: number): void;
  /** The event was dead-lettered: an alerting log line. */
  outboxDead(event: {
    readonly outboxEventId: OutboxEventId;
    readonly reason: OutboxDeadReason;
    readonly correlationId: CorrelationId;
  }): void;
  /** Something that should not happen but must not fail the request (warn). */
  anomaly(event: {
    readonly code: TrackingAnomalyCode;
    readonly outboxEventId: OutboxEventId;
    readonly correlationId: CorrelationId;
  }): void;
}
