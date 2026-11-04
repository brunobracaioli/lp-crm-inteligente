/**
 * Ports of the crm write and data-subject-rights use cases (Onda 9b). Kept apart from the frozen
 * `application/ports.ts`: they are additive and owned by this slice. Each port that touches the
 * database receives the workspace-scoped `Transaction` of the unit of work.
 */
import type { LeadState } from '#/modules/crm/application/ports.ts';
import type { LeadActivityType, LeadStage, ScoreBand } from '#/modules/crm/domain/lead-types.ts';
import type { MemberRole } from '#/modules/crm/domain/stage.ts';
import type { IdempotencyKey, LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

/** The authenticated staff member as the use cases see it (built by the presentation layer). */
export interface StaffActor {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly role: MemberRole;
}

// ---------------------------------------------------------------------------
// Persistence

/** Reads a lead by id inside the workspace of the transaction (RLS is the second barrier). */
export interface LeadReader {
  findById(tx: Transaction, workspaceId: WorkspaceId, leadId: LeadId): Promise<LeadState | null>;
  /** Same row, locked until the transaction ends (`FOR UPDATE`). */
  findByIdForUpdate(
    tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
  ): Promise<LeadState | null>;
}

/** `core.workspace_members` (read-only for the runtime role). */
export interface MemberDirectory {
  isActiveMember(tx: Transaction, workspaceId: WorkspaceId, userId: UserId): Promise<boolean>;
}

export interface StoredNote {
  readonly id: string;
  readonly actorId: UserId | null;
  readonly body: string;
  readonly createdAt: Date;
}

/** Notes are `note_added` rows of `crm.lead_activities`; appends go through `LeadActivityRepository`. */
export interface LeadNoteReader {
  find(
    tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
    noteId: string,
  ): Promise<StoredNote | null>;
}

/** Stages that feed offline conversions (crm §4): only these enqueue `lead.stage_changed`. */
export type ConversionStage = Extract<LeadStage, 'qualified' | 'won'>;

export interface StageChangedEvent {
  readonly workspaceId: WorkspaceId;
  readonly leadId: LeadId;
  readonly toStage: ConversionStage;
  readonly occurredAt: Date;
}

/**
 * Transactional outbox for `lead.stage_changed`. The adapter derives a deterministic event id
 * from lead + stage, so re-qualifying a reopened lead never duplicates a conversion.
 */
export interface StageChangeOutbox {
  enqueue(tx: Transaction, event: StageChangedEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Export (staff CSV)

export type ExportOwnerFilter =
  { readonly kind: 'user'; readonly userId: UserId } | { readonly kind: 'unassigned' };

export interface LeadExportFilter {
  readonly stage?: LeadStage;
  readonly owner?: ExportOwnerFilter;
  readonly scoreBand?: ScoreBand;
}

/** One data row of the CSV, in the contract's column order. No IP, UA, message, click IDs or notes. */
export interface LeadExportRow {
  readonly leadId: string;
  readonly createdAt: Date;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly whatsapp: string;
  readonly companyName: string;
  readonly areaOfExpertise: string;
  readonly areaOfExpertiseOther: string | null;
  readonly jobTitle: string | null;
  readonly companySize: string | null;
  readonly companyWebsite: string | null;
  readonly stage: string;
  readonly lostReason: string | null;
  readonly score: number;
  readonly scoreBand: string;
  readonly ownerUserId: string | null;
  readonly marketingOptIn: boolean;
  readonly submissionsCount: number;
  readonly firstSubmittedAt: Date;
  readonly lastSubmittedAt: Date;
  readonly anonymizedAt: Date | null;
  readonly firstTouchUtmSource: string | null;
  readonly firstTouchUtmMedium: string | null;
  readonly firstTouchUtmCampaign: string | null;
  readonly lastTouchUtmSource: string | null;
  readonly lastTouchUtmMedium: string | null;
  readonly lastTouchUtmCampaign: string | null;
}

export interface LeadExportReader {
  /** `created_at DESC, id ASC`, at most `limit` rows. */
  read(
    tx: Transaction,
    workspaceId: WorkspaceId,
    filter: LeadExportFilter,
    limit: number,
  ): Promise<readonly LeadExportRow[]>;
}

/** Held while one export of a user runs. */
export interface ExportLease {
  release(): Promise<void>;
}

/**
 * One concurrent export per user. `acquire` resolves to `null` when the user already has one in
 * flight and REJECTS when the lock backend is unavailable (the export is fail-closed).
 */
export interface ExportLock {
  acquire(workspaceId: WorkspaceId, userId: UserId): Promise<ExportLease | null>;
}

// ---------------------------------------------------------------------------
// Data-subject rights

export interface SubjectSubmission {
  readonly id: string;
  readonly createdAt: Date;
  /** `capture.submissions.fields` as stored (an object; the view whitelists the keys). */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmTerm: string | null;
  readonly utmContent: string | null;
  readonly utmId: string | null;
  readonly gclid: string | null;
  readonly gbraid: string | null;
  readonly wbraid: string | null;
  readonly fbclid: string | null;
  readonly ttclid: string | null;
  readonly msclkid: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly gaClientId: string | null;
  readonly landingPageUrl: string | null;
  readonly referrerUrl: string | null;
  readonly consentState: Readonly<Record<string, unknown>>;
  readonly clientIp: string | null;
  readonly userAgent: string | null;
}

export interface SubjectConsent {
  readonly purpose: string;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly recordedAt: Date;
}

export interface SubjectActivity {
  readonly id: string;
  readonly type: LeadActivityType;
  readonly actorType: 'system' | 'user' | 'ai';
  readonly actorId: string | null;
  readonly createdAt: Date;
  /** Stored payload (codes, IDs and, for notes, the body); the view maps it to the contract. */
  readonly data: Readonly<Record<string, unknown>>;
}

/** Everything held about one lead besides the lead row itself. Arrays are already capped. */
export interface SubjectDataBundle {
  readonly submissions: readonly SubjectSubmission[];
  readonly consents: readonly SubjectConsent[];
  readonly activities: readonly SubjectActivity[];
  /** True when any array was cut at its limit. */
  readonly truncated: boolean;
}

export interface SubjectDataReader {
  read(tx: Transaction, workspaceId: WorkspaceId, leadId: LeadId): Promise<SubjectDataBundle>;
}

/** What `crm.anonymize_lead` would erase, counted from the database (crm §7, G4). */
export interface ErasureInventory {
  readonly submissionFields: number;
  readonly submissionMessages: number;
  readonly submissionTrackingIdentifiers: number;
  readonly submissionIpAndUserAgent: number;
  readonly activityNotes: number;
}

export interface AnonymizationGateway {
  inventory(tx: Transaction, workspaceId: WorkspaceId, leadId: LeadId): Promise<ErasureInventory>;
  /**
   * `crm.anonymize_lead`: true = anonymized now; false = not visible in the workspace or already
   * anonymized. Runs inside the caller's workspace-scoped transaction.
   */
  anonymize(
    tx: Transaction,
    leadId: LeadId,
    actor: { readonly userId: UserId },
    correlationId: string,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Idempotency (contract `x-idempotency`)

export type IdempotentOperation = 'stage' | 'owner' | 'note' | 'anonymize';

export interface IdempotencyScope {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly operation: IdempotentOperation;
  readonly resourceId: string;
  readonly key: IdempotencyKey;
}

/**
 * What a completed request leaves behind: references only, never the response body. Replays
 * rebuild the response from the database, so no lead data (PII) sits in Redis for 24 h.
 */
export type StoredOutcome =
  | { readonly kind: 'lead'; readonly leadId: string; readonly version: number }
  | { readonly kind: 'note'; readonly leadId: string; readonly noteId: string }
  | {
      readonly kind: 'anonymized';
      readonly leadId: string;
      readonly anonymizedAt: string;
      readonly version: number;
    };

export type IdempotencyClaim =
  | { readonly status: 'claimed' }
  | { readonly status: 'in_progress'; readonly requestHash: string }
  | { readonly status: 'completed'; readonly requestHash: string; readonly outcome: StoredOutcome }
  | { readonly status: 'unavailable' };

export interface StaffIdempotencyStore {
  claim(scope: IdempotencyScope, requestHash: string): Promise<IdempotencyClaim>;
  complete(scope: IdempotencyScope, requestHash: string, outcome: StoredOutcome): Promise<void>;
  /** Drops an `in_progress` marker after a failed attempt so the client can retry. */
  release(scope: IdempotencyScope): Promise<void>;
}
