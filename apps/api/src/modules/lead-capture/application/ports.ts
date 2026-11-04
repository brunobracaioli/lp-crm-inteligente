/**
 * Ports of the `lead-capture` application layer (lead-capture §2). FROZEN in Onda 0:
 * Onda 2 writes fakes + SubmitLead against them, Onda 3 implements Turnstile/Upstash adapters,
 * Onda 4 implements the Postgres adapters. A wave that needs to change a port stops and opens a
 * separate PR first (docs/plan/implementation-waves.md).
 */
import type { RegisterInboundLead } from '#/modules/crm/public-api.ts';
import type { OutboxEventDraft, TriggerOutboxDispatch } from '#/modules/tracking/public-api.ts';
import type { AuditLogWriter } from '#/shared/audit.ts';
import type { ConsentPurpose, ConsentState } from '#/shared/consent.ts';
import type {
  EventId,
  FormId,
  IdempotencyKey,
  IdGenerator,
  LeadId,
  SubmissionId,
  WorkspaceId,
} from '#/shared/ids.ts';
import type { AttributionSnapshot } from '#/shared/lead-profile.ts';
import type { Clock } from '#/shared/time.ts';
import type { Transaction, UnitOfWork } from '#/shared/unit-of-work.ts';

export type { AuditEntry, AuditLogWriter } from '#/shared/audit.ts';
export type { Clock } from '#/shared/time.ts';
export type { IdGenerator } from '#/shared/ids.ts';
export type { Transaction, UnitOfWork } from '#/shared/unit-of-work.ts';
export type { RegisterInboundLead } from '#/modules/crm/public-api.ts';
export type { TriggerOutboxDispatch } from '#/modules/tracking/public-api.ts';

// ---------------------------------------------------------------------------
// Step 5 — form lookup (public routing: no workspace filter, only status = 'active')

export interface FormDefinition {
  readonly id: FormId;
  readonly workspaceId: WorkspaceId;
  readonly formKey: string;
  /** https origins allowed to post this form; Turnstile hostnames derive from them. */
  readonly allowedOrigins: readonly string[];
  readonly turnstileAction: string;
  readonly privacyPolicyVersion: string;
}

export interface FormLookup {
  /** Null for unknown, paused or archived forms (→ 404 form_not_found). */
  findActiveByKey(formKey: string): Promise<FormDefinition | null>;
}

// ---------------------------------------------------------------------------
// Steps 4 and 10 — rate limiting (adapters HMAC every identifier; fail-open is adapter behaviour)

export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  /** IP windows (5/10 min, 30/24 h) plus the bot-failure block (≥ 10 failures / 10 min → 1 h). */
  checkIp(clientIp: string): Promise<RateLimitDecision>;
  /** 300 req/min per form_key. */
  checkForm(formKey: string): Promise<RateLimitDecision>;
  /** 3 submissions/h per normalized e-mail. */
  checkEmail(normalizedEmail: string): Promise<RateLimitDecision>;
  /** Counts a failed Turnstile verification towards the IP block. */
  recordBotFailure(clientIp: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Step 6 — human proof (Turnstile siteverify)

export interface AntiBotVerificationRequest {
  readonly token: string;
  readonly remoteIp: string | null;
  readonly expectedHostnames: readonly string[];
  readonly expectedAction: string;
  readonly idempotencyKey: IdempotencyKey;
}

export type AntiBotFailureReason =
  'invalid_token' | 'token_reused' | 'hostname_mismatch' | 'action_mismatch' | 'stale_challenge';

export type AntiBotVerification =
  | {
      readonly outcome: 'passed';
      readonly challengeAgeSeconds: number;
      readonly ephemeralId: string | null;
    }
  | { readonly outcome: 'failed'; readonly reason: AntiBotFailureReason }
  /** Network error / timeout (3 s) → 503 bot_verification_unavailable (fail-closed). */
  | { readonly outcome: 'unavailable' };

export interface AntiBotVerifier {
  verify(request: AntiBotVerificationRequest): Promise<AntiBotVerification>;
}

// ---------------------------------------------------------------------------
// Steps 9 and 12 — idempotency (R7). The use case computes `requestHash` (SHA-256 of the
// normalized payload without turnstile_token); the store only persists and compares it.

/** Body of the 202 response, replayed verbatim for a repeated key. */
export interface AcceptedSubmission {
  readonly submissionId: SubmissionId;
  readonly eventId: EventId;
}

export type IdempotencyClaim =
  | { readonly status: 'claimed' }
  | { readonly status: 'in_progress'; readonly requestHash: string }
  | {
      readonly status: 'completed';
      readonly requestHash: string;
      readonly response: AcceptedSubmission;
    }
  /** Redis down: continue; the UNIQUE (workspace_id, idempotency_key) is the second barrier. */
  | { readonly status: 'unavailable' };

export interface IdempotencyStore {
  /** SET NX EX 86400 with state `in_progress`. */
  claim(
    workspaceId: WorkspaceId,
    key: IdempotencyKey,
    requestHash: string,
  ): Promise<IdempotencyClaim>;
  /** Stores the accepted response (state `completed`). */
  complete(
    workspaceId: WorkspaceId,
    key: IdempotencyKey,
    requestHash: string,
    response: AcceptedSubmission,
  ): Promise<void>;
  /** Frees an `in_progress` claim after a failure so the client can retry. */
  release(workspaceId: WorkspaceId, key: IdempotencyKey): Promise<void>;
}

// ---------------------------------------------------------------------------
// Step 11 — persistence inside the unit of work

export type SubmissionFieldValue = string | boolean | null;

export interface SubmissionRecord {
  readonly id: SubmissionId;
  readonly workspaceId: WorkspaceId;
  readonly formId: FormId;
  readonly leadId: LeadId;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestHash: string;
  readonly eventId: EventId;
  /** Normalized form fields of this submission (capture.submissions.fields). */
  readonly fields: Readonly<Record<string, SubmissionFieldValue>>;
  readonly message: string | null;
  readonly attribution: AttributionSnapshot;
  readonly consentState: ConsentState;
  /** Raw values kept 30 days for anti-fraud/CAPI, then purged (database §6). */
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  readonly ipHmac: string;
  readonly antibot: {
    readonly provider: 'turnstile';
    readonly challengeAgeSeconds: number;
    readonly ephemeralId: string | null;
  };
  readonly createdAt: Date;
}

export interface StoredSubmissionReference {
  readonly submissionId: SubmissionId;
  readonly eventId: EventId;
  readonly requestHash: string;
}

export interface SubmissionRepository {
  /**
   * `ON CONFLICT DO NOTHING` — never aborts the transaction. Reports which UNIQUE was hit:
   * `(workspace_id, idempotency_key)` → replay path; `(workspace_id, event_id)` → the client reused a
   * Pixel `event_id` under a new key, the use case retries once with a server-generated id.
   */
  insert(
    tx: Transaction,
    submission: SubmissionRecord,
  ): Promise<'inserted' | 'duplicate_idempotency_key' | 'duplicate_event_id'>;
  /** Replay path when Redis was unavailable and the key already exists in the database. */
  findByIdempotencyKey(
    tx: Transaction,
    workspaceId: WorkspaceId,
    key: IdempotencyKey,
  ): Promise<StoredSubmissionReference | null>;
}

export interface ConsentRecord {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly leadId: LeadId;
  readonly submissionId: SubmissionId;
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly createdAt: Date;
}

export interface ConsentRepository {
  /** Append-only (R4): privacy_policy, marketing_communications, ad_tracking. */
  appendMany(tx: Transaction, consents: readonly ConsentRecord[]): Promise<void>;
}

export interface OutboxWriter {
  /** Inserts the `lead.captured` event in the same commit (R6). */
  enqueue(tx: Transaction, event: OutboxEventDraft): Promise<void>;
}

/** Everything SubmitLead needs, injected by the composition root (Onda 4). */
export interface SubmitLeadDependencies {
  readonly forms: FormLookup;
  readonly rateLimiter: RateLimiter;
  readonly antiBot: AntiBotVerifier;
  readonly idempotency: IdempotencyStore;
  readonly unitOfWork: UnitOfWork;
  readonly submissions: SubmissionRepository;
  readonly consents: ConsentRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditLogWriter;
  readonly registerInboundLead: RegisterInboundLead;
  readonly triggerOutboxDispatch: TriggerOutboxDispatch;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** HMAC-SHA256 with HASH_PEPPER (platform/crypto) for `ip_hmac`. */
  readonly hmac: (value: string) => string;
}
