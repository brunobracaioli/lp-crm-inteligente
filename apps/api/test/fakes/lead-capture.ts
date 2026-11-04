import type { AuditEntry, AuditLogWriter } from '#/shared/audit.ts';
import type { CorrelationId, IdempotencyKey, OutboxEventId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  AcceptedSubmission,
  AntiBotVerification,
  AntiBotVerificationRequest,
  AntiBotVerifier,
  ConsentRecord,
  ConsentRepository,
  FormDefinition,
  FormLookup,
  IdempotencyClaim,
  IdempotencyStore,
  OutboxWriter,
  RateLimitDecision,
  RateLimiter,
  StoredSubmissionReference,
  SubmissionRecord,
  SubmissionRepository,
} from '#/modules/lead-capture/application/ports.ts';
import type { OutboxEventDraft } from '#/modules/tracking/public-api.ts';
import type { CallLog } from './call-log.ts';
import { Table, type TransactionRegistry, type Transactional } from './transactions.ts';

const ALLOWED: RateLimitDecision = { allowed: true };

export class FakeFormLookup implements FormLookup {
  readonly #forms = new Map<string, FormDefinition>();
  readonly #log: CallLog | undefined;

  constructor(forms: readonly FormDefinition[], log?: CallLog) {
    for (const form of forms) {
      this.#forms.set(form.formKey, form);
    }
    this.#log = log;
  }

  /** Pauses or archives a form: lookups return null from now on. */
  deactivate(formKey: string): void {
    this.#forms.delete(formKey);
  }

  findActiveByKey(formKey: string): Promise<FormDefinition | null> {
    this.#log?.record('forms.findActiveByKey');
    return Promise.resolve(this.#forms.get(formKey) ?? null);
  }
}

/** Scripted limiter: every scope allows by default; tests flip a scope to blocked. */
export class FakeRateLimiter implements RateLimiter {
  ip: RateLimitDecision = ALLOWED;
  form: RateLimitDecision = ALLOWED;
  email: RateLimitDecision = ALLOWED;
  readonly checkedIps: string[] = [];
  readonly checkedForms: string[] = [];
  readonly checkedEmails: string[] = [];
  readonly botFailures: string[] = [];
  readonly #log: CallLog | undefined;

  constructor(log?: CallLog) {
    this.#log = log;
  }

  checkIp(clientIp: string): Promise<RateLimitDecision> {
    this.#log?.record('rateLimiter.checkIp');
    this.checkedIps.push(clientIp);
    return Promise.resolve(this.ip);
  }

  checkForm(formKey: string): Promise<RateLimitDecision> {
    this.#log?.record('rateLimiter.checkForm');
    this.checkedForms.push(formKey);
    return Promise.resolve(this.form);
  }

  checkEmail(normalizedEmail: string): Promise<RateLimitDecision> {
    this.#log?.record('rateLimiter.checkEmail');
    this.checkedEmails.push(normalizedEmail);
    return Promise.resolve(this.email);
  }

  recordBotFailure(clientIp: string): Promise<void> {
    this.#log?.record('rateLimiter.recordBotFailure');
    this.botFailures.push(clientIp);
    return Promise.resolve();
  }
}

export class FakeAntiBotVerifier implements AntiBotVerifier {
  outcome: AntiBotVerification = { outcome: 'passed', challengeAgeSeconds: 4, ephemeralId: null };
  readonly requests: AntiBotVerificationRequest[] = [];
  readonly #log: CallLog | undefined;

  constructor(log?: CallLog) {
    this.#log = log;
  }

  verify(request: AntiBotVerificationRequest): Promise<AntiBotVerification> {
    this.#log?.record('antiBot.verify');
    this.requests.push(request);
    return Promise.resolve(this.outcome);
  }
}

type StoredClaim =
  | { readonly state: 'in_progress'; readonly requestHash: string }
  | {
      readonly state: 'completed';
      readonly requestHash: string;
      readonly response: AcceptedSubmission;
    };

/** In-memory `SET NX EX` store; `down = true` mimics Redis being unreachable. */
export class FakeIdempotencyStore implements IdempotencyStore {
  down = false;
  readonly releases: string[] = [];
  readonly completions: AcceptedSubmission[] = [];
  readonly #entries = new Map<string, StoredClaim>();
  readonly #log: CallLog | undefined;

  constructor(log?: CallLog) {
    this.#log = log;
  }

  claim(
    workspaceId: WorkspaceId,
    key: IdempotencyKey,
    requestHash: string,
  ): Promise<IdempotencyClaim> {
    this.#log?.record('idempotency.claim');
    if (this.down) {
      return Promise.resolve({ status: 'unavailable' });
    }
    const entry = this.#entries.get(this.#keyOf(workspaceId, key));
    if (entry === undefined) {
      this.#entries.set(this.#keyOf(workspaceId, key), { state: 'in_progress', requestHash });
      return Promise.resolve({ status: 'claimed' });
    }
    return Promise.resolve(
      entry.state === 'completed'
        ? { status: 'completed', requestHash: entry.requestHash, response: entry.response }
        : { status: 'in_progress', requestHash: entry.requestHash },
    );
  }

  complete(
    workspaceId: WorkspaceId,
    key: IdempotencyKey,
    requestHash: string,
    response: AcceptedSubmission,
  ): Promise<void> {
    this.#log?.record('idempotency.complete');
    this.completions.push(response);
    this.#entries.set(this.#keyOf(workspaceId, key), { state: 'completed', requestHash, response });
    return Promise.resolve();
  }

  release(workspaceId: WorkspaceId, key: IdempotencyKey): Promise<void> {
    this.#log?.record('idempotency.release');
    this.releases.push(this.#keyOf(workspaceId, key));
    const entry = this.#entries.get(this.#keyOf(workspaceId, key));
    if (entry?.state === 'in_progress') {
      this.#entries.delete(this.#keyOf(workspaceId, key));
    }
    return Promise.resolve();
  }

  // --- test helpers ---

  stateOf(workspaceId: WorkspaceId, key: IdempotencyKey): StoredClaim | undefined {
    return this.#entries.get(this.#keyOf(workspaceId, key));
  }

  /** Drops the entry, as when the 24 h TTL elapsed. */
  forget(workspaceId: WorkspaceId, key: IdempotencyKey): void {
    this.#entries.delete(this.#keyOf(workspaceId, key));
  }

  /** Pretends another request is processing `key` right now. */
  seedInProgress(workspaceId: WorkspaceId, key: IdempotencyKey, requestHash: string): void {
    this.#entries.set(this.#keyOf(workspaceId, key), { state: 'in_progress', requestHash });
  }

  #keyOf(workspaceId: WorkspaceId, key: IdempotencyKey): string {
    return `${workspaceId}:${key}`;
  }
}

/** `capture.submissions` with `UNIQUE (workspace_id, idempotency_key)`. */
export class FakeSubmissionRepository implements SubmissionRepository, Transactional {
  readonly #table = new Table<SubmissionRecord>();
  readonly #registry: TransactionRegistry;
  readonly #log: CallLog | undefined;

  constructor(registry: TransactionRegistry, log?: CallLog) {
    this.#registry = registry;
    this.#log = log;
  }

  get records(): readonly SubmissionRecord[] {
    return this.#table.rows;
  }

  captureState(): () => void {
    return this.#table.captureState();
  }

  insert(
    tx: Transaction,
    submission: SubmissionRecord,
  ): Promise<'inserted' | 'duplicate_idempotency_key' | 'duplicate_event_id'> {
    this.#log?.record('submissions.insert');
    this.#registry.assertWritable(tx, submission.workspaceId);
    const duplicate = this.#table.rows.some(
      (row) =>
        row.workspaceId === submission.workspaceId &&
        row.idempotencyKey === submission.idempotencyKey,
    );
    if (duplicate) {
      return Promise.resolve('duplicate_idempotency_key');
    }
    const eventIdTaken = this.#table.rows.some(
      (row) => row.workspaceId === submission.workspaceId && row.eventId === submission.eventId,
    );
    if (eventIdTaken) {
      return Promise.resolve('duplicate_event_id');
    }
    this.#table.add(submission);
    return Promise.resolve('inserted');
  }

  findByIdempotencyKey(
    tx: Transaction,
    workspaceId: WorkspaceId,
    key: IdempotencyKey,
  ): Promise<StoredSubmissionReference | null> {
    this.#log?.record('submissions.findByIdempotencyKey');
    this.#registry.assertWritable(tx, workspaceId);
    const row = this.#table.rows.find(
      (candidate) => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key,
    );
    return Promise.resolve(
      row === undefined
        ? null
        : { submissionId: row.id, eventId: row.eventId, requestHash: row.requestHash },
    );
  }

  /** Stores a submission as if committed earlier (e.g. while Redis was down). */
  seed(submission: SubmissionRecord): void {
    this.#table.add(submission);
  }
}

/** Append-only `capture.consents`. */
export class FakeConsentRepository implements ConsentRepository, Transactional {
  readonly #table = new Table<ConsentRecord>();
  readonly #registry: TransactionRegistry;
  readonly #log: CallLog | undefined;

  constructor(registry: TransactionRegistry, log?: CallLog) {
    this.#registry = registry;
    this.#log = log;
  }

  get records(): readonly ConsentRecord[] {
    return this.#table.rows;
  }

  captureState(): () => void {
    return this.#table.captureState();
  }

  appendMany(tx: Transaction, consents: readonly ConsentRecord[]): Promise<void> {
    this.#log?.record('consents.appendMany');
    for (const consent of consents) {
      this.#registry.assertWritable(tx, consent.workspaceId);
      this.#table.add(consent);
    }
    return Promise.resolve();
  }
}

/** `tracking.outbox_events`; `failure` makes `enqueue` reject after earlier writes happened. */
export class FakeOutboxWriter implements OutboxWriter, Transactional {
  failure: Error | null = null;
  readonly #table = new Table<OutboxEventDraft>();
  readonly #registry: TransactionRegistry;
  readonly #log: CallLog | undefined;

  constructor(registry: TransactionRegistry, log?: CallLog) {
    this.#registry = registry;
    this.#log = log;
  }

  get events(): readonly OutboxEventDraft[] {
    return this.#table.rows;
  }

  captureState(): () => void {
    return this.#table.captureState();
  }

  enqueue(tx: Transaction, event: OutboxEventDraft): Promise<void> {
    this.#log?.record('outbox.enqueue');
    this.#registry.assertWritable(tx, event.workspaceId);
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    this.#table.add(event);
    return Promise.resolve();
  }
}

/** Append-only `core.audit_log`. */
export class FakeAuditLogWriter implements AuditLogWriter, Transactional {
  readonly #table = new Table<AuditEntry>();
  readonly #registry: TransactionRegistry;
  readonly #log: CallLog | undefined;

  constructor(registry: TransactionRegistry, log?: CallLog) {
    this.#registry = registry;
    this.#log = log;
  }

  get entries(): readonly AuditEntry[] {
    return this.#table.rows;
  }

  captureState(): () => void {
    return this.#table.captureState();
  }

  append(tx: Transaction, entry: AuditEntry): Promise<void> {
    this.#log?.record('audit.append');
    this.#registry.assertWritable(tx, entry.workspaceId);
    this.#table.add(entry);
    return Promise.resolve();
  }
}

export interface DispatchCall {
  readonly outboxEventId: OutboxEventId;
  readonly correlationId: CorrelationId;
}

/** `TriggerOutboxDispatch`: records the post-commit publish; `throwOnCall` proves it is non-fatal. */
export class FakeOutboxDispatchTrigger {
  readonly calls: DispatchCall[] = [];
  throwOnCall: Error | null = null;
  readonly #log: CallLog | undefined;

  constructor(log?: CallLog) {
    this.#log = log;
  }

  readonly trigger = (outboxEventId: OutboxEventId, correlationId: CorrelationId): void => {
    this.#log?.record('dispatch.trigger');
    this.calls.push({ outboxEventId, correlationId });
    if (this.throwOnCall !== null) {
      throw this.throwOnCall;
    }
  };
}
