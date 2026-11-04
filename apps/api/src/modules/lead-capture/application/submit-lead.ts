import type {
  CorrelationId,
  EventId,
  IdempotencyKey,
  OutboxEventId,
  SubmissionId,
  WorkspaceId,
} from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';
import type {
  AcceptedSubmission,
  AntiBotFailureReason,
  ConsentRecord,
  FormDefinition,
  RateLimitDecision,
  StoredSubmissionReference,
  SubmissionRecord,
  SubmitLeadDependencies,
} from '#/modules/lead-capture/application/ports.ts';
import type { FieldError } from '#/modules/lead-capture/domain/field-error.ts';
import { canonicalizeForIdempotency } from '#/modules/lead-capture/domain/idempotency.ts';
import { hostnamesOfOrigins, isOriginAllowed } from '#/modules/lead-capture/domain/origin.ts';
import { USER_AGENT_MAX_LENGTH } from '#/modules/lead-capture/domain/rules.ts';
import {
  parseEnvelope,
  parseSubmission,
  submissionFields,
  type SubmissionSnapshot,
} from '#/modules/lead-capture/domain/submission.ts';
import { truncateCodePoints } from '#/modules/lead-capture/domain/text.ts';
import type { InboundLeadProfile } from '#/modules/crm/public-api.ts';

/**
 * Median latency a honeypot request waits so it is indistinguishable from a real submission (R2).
 * A starting point: re-measure against the p50 of the accepted path once Wave 4 is deployed.
 */
export const HONEYPOT_SIMULATED_LATENCY_MS = 350;
/** Rate-limit bucket and HMAC input when the platform could not determine the client IP. */
export const UNKNOWN_CLIENT_IP = 'unknown';
export const IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS = 1;

export interface SubmitLeadCommand {
  /** Parsed JSON body, untrusted. Transport guards (Origin CORS, content type, size) ran before. */
  readonly body: unknown;
  /** `Origin` header of the request, or null when absent. */
  readonly origin: string | null;
  /** Already validated `Idempotency-Key` header (`parseIdempotencyKey`). */
  readonly idempotencyKey: IdempotencyKey;
  /** From `ipAddress()` of `@vercel/functions`: a valid IP literal or null, never a header copy. */
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  readonly correlationId: CorrelationId;
}

export type RateLimitScope = 'ip' | 'form' | 'email';

/** Every business refusal of the use case; the presentation maps `code` to status and problem. */
export type SubmitLeadFailure =
  | {
      readonly code: 'rate_limited';
      readonly scope: RateLimitScope;
      readonly retryAfterSeconds: number;
    }
  | { readonly code: 'validation_failed'; readonly errors: readonly FieldError[] }
  | { readonly code: 'form_not_found' }
  | { readonly code: 'origin_not_allowed' }
  /** `reason` is for logs and metrics only: never expose which check failed. */
  | { readonly code: 'bot_verification_failed'; readonly reason: AntiBotFailureReason }
  | { readonly code: 'bot_verification_unavailable' }
  | { readonly code: 'idempotency_in_progress'; readonly retryAfterSeconds: number }
  | { readonly code: 'idempotency_key_reused' };

/**
 * How the request was served. Internal (metrics `lead_capture.requests{outcome}`): the HTTP body
 * is `AcceptedSubmission` in every case so new lead, existing lead, replay and honeypot cannot be
 * told apart (R2).
 */
export type SubmitLeadOutcome = 'accepted' | 'replayed' | 'honeypot';

export interface SubmitLeadAccepted {
  readonly accepted: AcceptedSubmission;
  readonly outcome: SubmitLeadOutcome;
}

export type SubmitLeadResult = Result<SubmitLeadAccepted, SubmitLeadFailure>;
export type SubmitLead = (command: SubmitLeadCommand) => Promise<SubmitLeadResult>;

/**
 * Internal rollback signal. `UnitOfWork.run` commits when the work resolves and rolls back when it
 * rejects, so a duplicate idempotency key found after the lead was already upserted has to reject.
 * The stored reference travels in a `DuplicateProbe`, not in the error, so a unit of work that
 * wraps or replaces the rejection cannot hide the duplicate.
 */
class DuplicateSubmissionRollback extends Error {
  constructor() {
    super('submission with the same idempotency key already exists');
    this.name = 'DuplicateSubmissionRollback';
  }
}

/** Rollback signal for a hit on UNIQUE (workspace_id, event_id); see `DuplicateProbe`. */
class EventIdCollisionRollback extends Error {
  constructor() {
    super('submission with the same event id already exists');
    this.name = 'EventIdCollisionRollback';
  }
}

/**
 * `existing` stays `undefined` unless the insert hit the UNIQUE (workspace_id, idempotency_key);
 * `eventIdCollision` turns true when it hit the UNIQUE (workspace_id, event_id) instead.
 */
interface DuplicateProbe {
  existing: StoredSubmissionReference | null | undefined;
  eventIdCollision: boolean;
}

const refuse = (failure: SubmitLeadFailure): SubmitLeadResult => err(failure);

function rateLimited(scope: RateLimitScope, decision: RateLimitDecision): SubmitLeadResult | null {
  return decision.allowed
    ? null
    : refuse({ code: 'rate_limited', scope, retryAfterSeconds: decision.retryAfterSeconds });
}

function toInboundLeadProfile(snapshot: SubmissionSnapshot): InboundLeadProfile {
  return {
    firstName: snapshot.firstName,
    lastName: snapshot.lastName,
    email: snapshot.email,
    whatsappE164: snapshot.whatsappE164,
    companyName: snapshot.companyName,
    areaOfExpertise: snapshot.areaOfExpertise,
    areaOfExpertiseOther: snapshot.areaOfExpertiseOther,
    jobTitle: snapshot.jobTitle,
    companySize: snapshot.companySize,
    companyWebsite: snapshot.companyWebsite,
    message: snapshot.message,
    marketingOptIn: snapshot.marketingOptIn,
  };
}

/**
 * `SubmitLead` (lead-capture §2, steps 4–12), in the fixed order of the spec:
 * IP limit → envelope, form lookup, Origin, form limit → Turnstile → full validation → honeypot →
 * idempotency claim → e-mail limit → one transaction (lead, submission, consents, outbox, audit) →
 * idempotent response → post-commit outbox publish. Steps 1–3 (headers, CORS, content type, size)
 * belong to the presentation layer.
 *
 * Infrastructure failures (database down, adapter bugs) are not business results: they reject,
 * after the idempotency claim is released so the client can retry.
 */
export function createSubmitLead(deps: SubmitLeadDependencies): SubmitLead {
  const releaseQuietly = async (workspaceId: WorkspaceId, key: IdempotencyKey): Promise<void> => {
    try {
      await deps.idempotency.release(workspaceId, key);
    } catch {
      // Best effort: the claim expires by TTL, and the original failure matters more.
    }
  };

  const completeQuietly = async (
    workspaceId: WorkspaceId,
    key: IdempotencyKey,
    requestHash: string,
    response: AcceptedSubmission,
  ): Promise<void> => {
    try {
      await deps.idempotency.complete(workspaceId, key, requestHash, response);
    } catch {
      // Best effort after the commit: replay then falls back to the UNIQUE (workspace, key).
    }
  };

  const persist = async (
    command: SubmitLeadCommand,
    form: FormDefinition,
    snapshot: SubmissionSnapshot,
    requestHash: string,
    antibot: SubmissionRecord['antibot'],
    eventId: EventId,
    duplicate: DuplicateProbe,
  ): Promise<{ accepted: AcceptedSubmission; outboxEventId: OutboxEventId }> => {
    const now = deps.clock.now();
    const { workspaceId } = form;
    return deps.unitOfWork.run(workspaceId, async (tx) => {
      const submissionId = deps.ids.uuidv7() as SubmissionId;
      const lead = await deps.registerInboundLead(tx, {
        workspaceId,
        submissionId,
        occurredAt: now,
        profile: toInboundLeadProfile(snapshot),
        attribution: snapshot.attribution,
        correlationId: command.correlationId,
      });

      const inserted = await deps.submissions.insert(tx, {
        id: submissionId,
        workspaceId,
        formId: form.id,
        leadId: lead.leadId,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        eventId,
        fields: submissionFields(snapshot),
        message: snapshot.message,
        attribution: snapshot.attribution,
        consentState: snapshot.consent,
        clientIp: command.clientIp,
        userAgent:
          command.userAgent === null || command.userAgent === ''
            ? null
            : truncateCodePoints(command.userAgent, USER_AGENT_MAX_LENGTH),
        ipHmac: deps.hmac(command.clientIp ?? UNKNOWN_CLIENT_IP),
        antibot,
        createdAt: now,
      });
      if (inserted === 'duplicate_idempotency_key') {
        duplicate.existing = await deps.submissions.findByIdempotencyKey(
          tx,
          workspaceId,
          command.idempotencyKey,
        );
        throw new DuplicateSubmissionRollback();
      }
      if (inserted === 'duplicate_event_id') {
        duplicate.eventIdCollision = true;
        throw new EventIdCollisionRollback();
      }

      const consent = (purpose: ConsentRecord['purpose'], granted: boolean): ConsentRecord => ({
        id: deps.ids.uuidv7(),
        workspaceId,
        leadId: lead.leadId,
        submissionId,
        purpose,
        granted,
        policyVersion: form.privacyPolicyVersion,
        createdAt: now,
      });
      await deps.consents.appendMany(tx, [
        consent('privacy_policy', true),
        consent('marketing_communications', snapshot.marketingOptIn),
        consent('ad_tracking', snapshot.consent.adUserData === 'granted'),
      ]);

      const outboxEventId = deps.ids.uuidv7() as OutboxEventId;
      await deps.outbox.enqueue(tx, {
        id: outboxEventId,
        workspaceId,
        aggregateType: 'lead',
        aggregateId: lead.leadId,
        eventType: 'lead.captured',
        payload: { lead_id: lead.leadId, submission_id: submissionId },
        createdAt: now,
      });

      await deps.audit.append(tx, {
        workspaceId,
        occurredAt: now,
        actorType: 'system',
        actorId: null,
        action: 'lead.captured',
        resourceType: 'submission',
        resourceId: submissionId,
        result: 'success',
        correlationId: command.correlationId,
        metadata: {
          lead_id: lead.leadId,
          form_id: form.id,
          event_id: eventId,
          lead_created: lead.isNew,
        },
      });

      return { accepted: { submissionId, eventId }, outboxEventId };
    });
  };

  /**
   * The database already holds this key (Redis was down or its 24 h TTL elapsed): replay the stored
   * response for the same payload, refuse a different one. The transaction was rolled back.
   */
  const resolveDuplicate = async (
    existing: StoredSubmissionReference | null,
    workspaceId: WorkspaceId,
    command: SubmitLeadCommand,
    requestHash: string,
    ownsClaim: boolean,
  ): Promise<SubmitLeadResult> => {
    if (existing === null) {
      if (ownsClaim) {
        await releaseQuietly(workspaceId, command.idempotencyKey);
      }
      throw new Error('idempotency key reported as duplicate but no submission was found');
    }
    if (existing.requestHash !== requestHash) {
      if (ownsClaim) {
        await releaseQuietly(workspaceId, command.idempotencyKey);
      }
      return refuse({ code: 'idempotency_key_reused' });
    }
    const accepted: AcceptedSubmission = {
      submissionId: existing.submissionId,
      eventId: existing.eventId,
    };
    if (ownsClaim) {
      await completeQuietly(workspaceId, command.idempotencyKey, requestHash, accepted);
    }
    return ok({ accepted, outcome: 'replayed' });
  };

  return async (command) => {
    const ipKey = command.clientIp ?? UNKNOWN_CLIENT_IP;

    // Step 4 — rate limit by IP (and the bot-failure block).
    const ipRefusal = rateLimited('ip', await deps.rateLimiter.checkIp(ipKey));
    if (ipRefusal !== null) {
      return ipRefusal;
    }

    // Step 5 — minimal envelope, form lookup, Origin ∈ form.allowed_origins, form limit.
    const envelope = parseEnvelope(command.body);
    if (!envelope.ok) {
      return refuse({ code: 'validation_failed', errors: envelope.error });
    }
    const form = await deps.forms.findActiveByKey(envelope.value.formKey);
    if (form === null) {
      return refuse({ code: 'form_not_found' });
    }
    if (!isOriginAllowed(command.origin, form.allowedOrigins)) {
      return refuse({ code: 'origin_not_allowed' });
    }
    const formRefusal = rateLimited('form', await deps.rateLimiter.checkForm(form.formKey));
    if (formRefusal !== null) {
      return formRefusal;
    }

    // Step 6 — Turnstile: the human proof of this public endpoint (fail-closed).
    const verification = await deps.antiBot.verify({
      token: envelope.value.turnstileToken,
      remoteIp: command.clientIp,
      expectedHostnames: hostnamesOfOrigins(form.allowedOrigins),
      expectedAction: form.turnstileAction,
      idempotencyKey: command.idempotencyKey,
    });
    if (verification.outcome === 'unavailable') {
      return refuse({ code: 'bot_verification_unavailable' });
    }
    if (verification.outcome === 'failed') {
      await deps.rateLimiter.recordBotFailure(ipKey);
      return refuse({ code: 'bot_verification_failed', reason: verification.reason });
    }

    // Step 7 — full schema and normalization (only humans get per-field errors).
    const parsed = parseSubmission(command.body, { allowedOrigins: form.allowedOrigins });
    if (!parsed.ok) {
      return refuse({ code: 'validation_failed', errors: parsed.error });
    }
    const { snapshot, honeypotFilled } = parsed.value;
    const eventId = (snapshot.eventId ?? deps.ids.uuidv7()) as EventId;

    // Step 8 — honeypot (R3): same 202 shape, random submission id, nothing persisted.
    if (honeypotFilled) {
      await deps.clock.sleep(HONEYPOT_SIMULATED_LATENCY_MS);
      return ok({
        accepted: { submissionId: deps.ids.uuidv7() as SubmissionId, eventId },
        outcome: 'honeypot',
      });
    }

    // Step 9 — idempotency (R7): the hash covers the normalized payload without the token.
    const requestHash = sha256Hex(canonicalizeForIdempotency(snapshot));
    const claim = await deps.idempotency.claim(
      form.workspaceId,
      command.idempotencyKey,
      requestHash,
    );
    if (claim.status === 'completed' || claim.status === 'in_progress') {
      if (claim.requestHash !== requestHash) {
        return refuse({ code: 'idempotency_key_reused' });
      }
      return claim.status === 'completed'
        ? ok({ accepted: claim.response, outcome: 'replayed' })
        : refuse({
            code: 'idempotency_in_progress',
            retryAfterSeconds: IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS,
          });
    }
    // 'unavailable' (Redis down): carry on, the database UNIQUE is the second barrier.
    const ownsClaim = claim.status === 'claimed';

    const duplicate: DuplicateProbe = { existing: undefined, eventIdCollision: false };
    try {
      // Step 10 — rate limit by e-mail, after the replay check so retries do not count.
      const emailRefusal = rateLimited('email', await deps.rateLimiter.checkEmail(snapshot.email));
      if (emailRefusal !== null) {
        if (ownsClaim) {
          await releaseQuietly(form.workspaceId, command.idempotencyKey);
        }
        return emailRefusal;
      }

      // Steps 11–12 — one transaction, then the idempotent response and the post-commit publish.
      const antibot: SubmissionRecord['antibot'] = {
        provider: 'turnstile',
        challengeAgeSeconds: verification.challengeAgeSeconds,
        ephemeralId: verification.ephemeralId,
      };
      const persistWith = (id: EventId) =>
        persist(command, form, snapshot, requestHash, antibot, id, duplicate);
      const { accepted, outboxEventId } = await persistWith(eventId).catch((error: unknown) => {
        if (!duplicate.eventIdCollision) {
          throw error;
        }
        // The client reused an event_id under a new key: accept the lead with a fresh server id
        // (Pixel×CAPI dedup is lost for this one event, a duplicate conversion is worse). Once only.
        duplicate.eventIdCollision = false;
        return persistWith(deps.ids.uuidv7() as EventId);
      });
      if (ownsClaim) {
        await completeQuietly(form.workspaceId, command.idempotencyKey, requestHash, accepted);
      }
      try {
        deps.triggerOutboxDispatch(outboxEventId, command.correlationId);
      } catch {
        // The port must not throw; if it does, the sweeper republishes the pending event.
      }
      return ok({ accepted, outcome: 'accepted' });
    } catch (error) {
      if (duplicate.existing !== undefined) {
        return resolveDuplicate(
          duplicate.existing,
          form.workspaceId,
          command,
          requestHash,
          ownsClaim,
        );
      }
      if (ownsClaim) {
        await releaseQuietly(form.workspaceId, command.idempotencyKey);
      }
      throw error;
    }
  };
}
