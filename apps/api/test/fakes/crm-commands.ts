import { createKeyedMac } from '#/platform/crypto/derived-key.ts';
import type { AuditEntry } from '#/shared/audit.ts';
import type { CorrelationId, IdempotencyKey, LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import {
  createAddLeadNote,
  type AddLeadNote,
} from '#/modules/crm/application/commands/add-lead-note.ts';
import {
  createAnonymizeLead,
  type AnonymizeLead,
} from '#/modules/crm/application/commands/anonymize-lead.ts';
import {
  createAssignLeadOwner,
  type AssignLeadOwner,
} from '#/modules/crm/application/commands/assign-lead-owner.ts';
import {
  createChangeLeadStage,
  type ChangeLeadStage,
} from '#/modules/crm/application/commands/change-lead-stage.ts';
import {
  createExportLeadData,
  type ExportLeadData,
} from '#/modules/crm/application/commands/export-lead-data.ts';
import {
  createExportLeadsCsv,
  type ExportLeadsCsv,
} from '#/modules/crm/application/commands/export-leads-csv.ts';
import type {
  AnonymizationGateway,
  ErasureInventory,
  ExportLease,
  ExportLock,
  IdempotencyClaim,
  IdempotencyScope,
  LeadExportFilter,
  LeadExportReader,
  LeadExportRow,
  LeadNoteReader,
  LeadReader,
  MemberDirectory,
  StageChangedEvent,
  StageChangeOutbox,
  StaffIdempotencyStore,
  StoredNote,
  StoredOutcome,
  SubjectDataBundle,
  SubjectDataReader,
} from '#/modules/crm/application/commands/ports.ts';
import {
  createRecordDenial,
  type RecordDenial,
} from '#/modules/crm/application/commands/record-denial.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import { EMPTY_ATTRIBUTION } from '#/modules/crm/domain/attribution.ts';
import { FakeClock } from './clock.ts';
import { FakeLeadActivityRepository, FakeLeadRepository } from './crm.ts';
import { SequentialIdGenerator } from './ids.ts';
import { FakeAuditLogWriter } from './lead-capture.ts';
import { CallLog } from './call-log.ts';
import { FakeUnitOfWork, TransactionRegistry, type Transactional } from './transactions.ts';

export const WORKSPACE_A = '00000000-0000-7000-8000-00000000a001' as WorkspaceId;
export const WORKSPACE_B = '00000000-0000-7000-8000-00000000b001' as WorkspaceId;
export const OWNER_USER = '00000000-0000-7000-8000-0000000000e1' as UserId;
export const ADMIN_USER = '00000000-0000-7000-8000-0000000000e2' as UserId;
export const SALES_USER = '00000000-0000-7000-8000-0000000000e3' as UserId;
export const OTHER_SALES_USER = '00000000-0000-7000-8000-0000000000e4' as UserId;
export const VIEWER_USER = '00000000-0000-7000-8000-0000000000e5' as UserId;
export const CORRELATION = '00000000-0000-4000-8000-00000000c0de' as CorrelationId;
export const PEPPER = Buffer.alloc(32, 9).toString('base64');
export const KEY_1 = '11111111-1111-4111-8111-111111111111' as IdempotencyKey;
export const KEY_2 = '22222222-2222-4222-8222-222222222222' as IdempotencyKey;

const LEAD_EPOCH = new Date('2026-11-03T12:00:00.000Z');

let leadCounter = 0;

/** A persisted lead of `workspaceId`; ids and e-mail are unique per call. */
export function aStoredLead(
  workspaceId: WorkspaceId,
  overrides: Partial<LeadState> = {},
): LeadState {
  leadCounter += 1;
  const suffix = leadCounter.toString(16).padStart(12, '0');
  return {
    id: `00000000-0000-7000-8000-${suffix}` as LeadId,
    workspaceId,
    firstName: 'Maria',
    lastName: 'Silva',
    email: `maria${String(leadCounter)}@empresa.com.br`,
    whatsappE164: '+5511912345678',
    companyName: 'Empresa Ltda',
    areaOfExpertise: 'technology',
    areaOfExpertiseOther: null,
    jobTitle: 'Head de Marketing',
    companySize: '11_50',
    companyWebsite: 'https://empresa.com.br',
    stage: 'new',
    lostReason: null,
    score: 42,
    scoreBand: 'B',
    scoreBreakdown: [{ ruleId: 'fit_size', points: 15 }],
    ownerUserId: null,
    marketingOptIn: true,
    submissionsCount: 1,
    firstTouch: { ...EMPTY_ATTRIBUTION, utmSource: 'meta', fbclid: 'IwAR1' },
    lastTouch: { ...EMPTY_ATTRIBUTION, utmSource: 'meta', fbclid: 'IwAR1' },
    firstSubmittedAt: LEAD_EPOCH,
    lastSubmittedAt: LEAD_EPOCH,
    anonymizedAt: null,
    version: 3,
    createdAt: LEAD_EPOCH,
    updatedAt: LEAD_EPOCH,
    ...overrides,
  };
}

export class FakeLeadReader implements LeadReader {
  readonly #leads: FakeLeadRepository;
  readonly #registry: TransactionRegistry;
  /** Calls of `findByIdForUpdate`, to prove the mutations lock the row. */
  lockedReads = 0;

  constructor(leads: FakeLeadRepository, registry: TransactionRegistry) {
    this.#leads = leads;
    this.#registry = registry;
  }

  #find(tx: Transaction, workspaceId: WorkspaceId, leadId: LeadId): LeadState | null {
    this.#registry.assertWritable(tx, workspaceId);
    return (
      this.#leads.all().find((lead) => lead.id === leadId && lead.workspaceId === workspaceId) ??
      null
    );
  }

  findById(tx: Transaction, workspaceId: WorkspaceId, leadId: LeadId): Promise<LeadState | null> {
    return Promise.resolve(this.#find(tx, workspaceId, leadId));
  }

  findByIdForUpdate(
    tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
  ): Promise<LeadState | null> {
    this.lockedReads += 1;
    return Promise.resolve(this.#find(tx, workspaceId, leadId));
  }
}

export class FakeMemberDirectory implements MemberDirectory {
  readonly active = new Set<string>();

  add(workspaceId: WorkspaceId, userId: UserId): void {
    this.active.add(`${workspaceId}:${userId}`);
  }

  isActiveMember(_tx: Transaction, workspaceId: WorkspaceId, userId: UserId): Promise<boolean> {
    return Promise.resolve(this.active.has(`${workspaceId}:${userId}`));
  }
}

export class FakeLeadNoteReader implements LeadNoteReader {
  readonly #activities: FakeLeadActivityRepository;

  constructor(activities: FakeLeadActivityRepository) {
    this.#activities = activities;
  }

  find(
    _tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
    noteId: string,
  ): Promise<StoredNote | null> {
    const row = this.#activities.records.find(
      (activity) =>
        activity.id === noteId &&
        activity.workspaceId === workspaceId &&
        activity.leadId === leadId &&
        activity.type === 'note_added',
    );
    return Promise.resolve(
      row === undefined
        ? null
        : {
            id: row.id,
            actorId: row.actorId,
            body: String(row.data.body),
            createdAt: row.createdAt,
          },
    );
  }
}

export class FakeStageChangeOutbox implements StageChangeOutbox, Transactional {
  events: readonly StageChangedEvent[] = [];

  captureState(): () => void {
    const saved = this.events;
    return () => {
      this.events = saved;
    };
  }

  enqueue(_tx: Transaction, event: StageChangedEvent): Promise<void> {
    this.events = [...this.events, event];
    return Promise.resolve();
  }
}

const scopeKey = (scope: IdempotencyScope): string =>
  [scope.workspaceId, scope.userId, scope.operation, scope.resourceId, scope.key].join(':');

type StoredEntry =
  | { readonly state: 'in_progress'; readonly requestHash: string }
  | { readonly state: 'completed'; readonly requestHash: string; readonly outcome: StoredOutcome };

export class FakeStaffIdempotencyStore implements StaffIdempotencyStore {
  readonly entries = new Map<string, StoredEntry>();
  /** When true every claim reports `unavailable` (Redis down). */
  unavailable = false;
  releases = 0;

  claim(scope: IdempotencyScope, requestHash: string): Promise<IdempotencyClaim> {
    if (this.unavailable) {
      return Promise.resolve({ status: 'unavailable' });
    }
    const existing = this.entries.get(scopeKey(scope));
    if (existing === undefined) {
      this.entries.set(scopeKey(scope), { state: 'in_progress', requestHash });
      return Promise.resolve({ status: 'claimed' });
    }
    return Promise.resolve(
      existing.state === 'in_progress'
        ? { status: 'in_progress', requestHash: existing.requestHash }
        : { status: 'completed', requestHash: existing.requestHash, outcome: existing.outcome },
    );
  }

  complete(scope: IdempotencyScope, requestHash: string, outcome: StoredOutcome): Promise<void> {
    this.entries.set(scopeKey(scope), { state: 'completed', requestHash, outcome });
    return Promise.resolve();
  }

  release(scope: IdempotencyScope): Promise<void> {
    this.releases += 1;
    if (this.entries.get(scopeKey(scope))?.state === 'in_progress') {
      this.entries.delete(scopeKey(scope));
    }
    return Promise.resolve();
  }
}

export class FakeExportLock implements ExportLock {
  readonly held = new Set<string>();
  /** When set, `acquire` rejects (lock backend down). */
  failure: Error | null = null;
  acquired = 0;
  released = 0;

  acquire(workspaceId: WorkspaceId, userId: UserId): Promise<ExportLease | null> {
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    const key = `${workspaceId}:${userId}`;
    if (this.held.has(key)) {
      return Promise.resolve(null);
    }
    this.held.add(key);
    this.acquired += 1;
    return Promise.resolve({
      release: () => {
        this.held.delete(key);
        this.released += 1;
        return Promise.resolve();
      },
    });
  }
}

/** Builds export rows from the fake lead store, applying the same filters as the SQL adapter. */
export class FakeLeadExportReader implements LeadExportReader {
  readonly #leads: FakeLeadRepository;
  lastFilter: LeadExportFilter | null = null;
  lastLimit = 0;
  /** Extra rows appended after the stored leads (to exceed the export ceiling cheaply). */
  extraRows: readonly LeadExportRow[] = [];

  constructor(leads: FakeLeadRepository) {
    this.#leads = leads;
  }

  read(
    _tx: Transaction,
    workspaceId: WorkspaceId,
    filter: LeadExportFilter,
    limit: number,
  ): Promise<readonly LeadExportRow[]> {
    this.lastFilter = filter;
    this.lastLimit = limit;
    const stored = this.#leads
      .all()
      .filter((lead) => lead.workspaceId === workspaceId)
      .filter((lead) => filter.stage === undefined || lead.stage === filter.stage)
      .filter((lead) => filter.scoreBand === undefined || lead.scoreBand === filter.scoreBand)
      .filter((lead) => {
        if (filter.owner === undefined) return true;
        return filter.owner.kind === 'unassigned'
          ? lead.ownerUserId === null
          : lead.ownerUserId === filter.owner.userId;
      })
      .map(toExportRow);
    return Promise.resolve([...stored, ...this.extraRows].slice(0, limit));
  }
}

export function toExportRow(lead: LeadState): LeadExportRow {
  return {
    leadId: lead.id,
    createdAt: lead.createdAt,
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    whatsapp: lead.whatsappE164,
    companyName: lead.companyName,
    areaOfExpertise: lead.areaOfExpertise,
    areaOfExpertiseOther: lead.areaOfExpertiseOther,
    jobTitle: lead.jobTitle,
    companySize: lead.companySize,
    companyWebsite: lead.companyWebsite,
    stage: lead.stage,
    lostReason: lead.lostReason,
    score: lead.score,
    scoreBand: lead.scoreBand,
    ownerUserId: lead.ownerUserId,
    marketingOptIn: lead.marketingOptIn,
    submissionsCount: lead.submissionsCount,
    firstSubmittedAt: lead.firstSubmittedAt,
    lastSubmittedAt: lead.lastSubmittedAt,
    anonymizedAt: lead.anonymizedAt,
    firstTouchUtmSource: lead.firstTouch.utmSource,
    firstTouchUtmMedium: lead.firstTouch.utmMedium,
    firstTouchUtmCampaign: lead.firstTouch.utmCampaign,
    lastTouchUtmSource: lead.lastTouch.utmSource,
    lastTouchUtmMedium: lead.lastTouch.utmMedium,
    lastTouchUtmCampaign: lead.lastTouch.utmCampaign,
  };
}

export class FakeSubjectDataReader implements SubjectDataReader {
  bundle: SubjectDataBundle = { submissions: [], consents: [], activities: [], truncated: false };

  read(): Promise<SubjectDataBundle> {
    return Promise.resolve(this.bundle);
  }
}

export class FakeAnonymizationGateway implements AnonymizationGateway {
  inventoryValue: ErasureInventory = {
    submissionFields: 2,
    submissionMessages: 1,
    submissionTrackingIdentifiers: 2,
    submissionIpAndUserAgent: 2,
    activityNotes: 1,
  };
  anonymizeCalls: { leadId: LeadId; userId: UserId; correlationId: string }[] = [];
  readonly #leads: FakeLeadRepository;
  readonly #clock: FakeClock;

  constructor(leads: FakeLeadRepository, clock: FakeClock) {
    this.#leads = leads;
    this.#clock = clock;
  }

  inventory(): Promise<ErasureInventory> {
    return Promise.resolve(this.inventoryValue);
  }

  async anonymize(
    tx: Transaction,
    leadId: LeadId,
    actor: { readonly userId: UserId },
    correlationId: string,
  ): Promise<boolean> {
    const lead = this.#leads.all().find((candidate) => candidate.id === leadId);
    if (lead?.anonymizedAt !== null) {
      return false;
    }
    this.anonymizeCalls.push({ leadId, userId: actor.userId, correlationId });
    // Like the SQL function: scrub the contact data, stamp the time, bump the version.
    await this.#leads.update(
      tx,
      {
        ...lead,
        firstName: 'Anonymized',
        lastName: 'Anonymized',
        email: `anon+${lead.id}@anonymized.invalid`,
        whatsappE164: '+10000000000',
        anonymizedAt: this.#clock.now(),
      },
      lead.version,
    );
    return true;
  }
}

/** Every command use case over in-memory ports sharing one fake unit of work. */
export function createCommandHarness() {
  const log = new CallLog();
  const registry = new TransactionRegistry();
  const leads = new FakeLeadRepository(registry, log);
  const activities = new FakeLeadActivityRepository(registry, log);
  const audit = new FakeAuditLogWriter(registry, log);
  const stageOutbox = new FakeStageChangeOutbox();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator();
  const unitOfWork = new FakeUnitOfWork(registry, [leads, activities, audit, stageOutbox], log);
  const leadReader = new FakeLeadReader(leads, registry);
  const members = new FakeMemberDirectory();
  const notes = new FakeLeadNoteReader(activities);
  const idempotency = new FakeStaffIdempotencyStore();
  const exportLock = new FakeExportLock();
  const exportReader = new FakeLeadExportReader(leads);
  const subjectData = new FakeSubjectDataReader();
  const gateway = new FakeAnonymizationGateway(leads, clock);
  const planMac = createKeyedMac(PEPPER, 'crm-plan-v1');

  const mutation = {
    unitOfWork,
    leads: leadReader,
    leadWriter: leads,
    activities,
    audit,
    idempotency,
    clock,
    ids,
  };

  const changeLeadStage: ChangeLeadStage = createChangeLeadStage({ ...mutation, stageOutbox });
  const assignLeadOwner: AssignLeadOwner = createAssignLeadOwner({ ...mutation, members });
  const addLeadNote: AddLeadNote = createAddLeadNote({ ...mutation, notes });
  const exportLeadsCsv: ExportLeadsCsv = createExportLeadsCsv({
    unitOfWork,
    reader: exportReader,
    lock: exportLock,
    audit,
    clock,
    ids,
  });
  const exportLeadData: ExportLeadData = createExportLeadData({
    unitOfWork,
    leads: leadReader,
    subjectData,
    audit,
    clock,
  });
  const anonymizeLead: AnonymizeLead = createAnonymizeLead({
    unitOfWork,
    leads: leadReader,
    gateway,
    audit,
    idempotency,
    planMac,
    clock,
  });
  const recordDenial: RecordDenial = createRecordDenial({ unitOfWork, audit, clock });

  members.add(WORKSPACE_A, OWNER_USER);
  members.add(WORKSPACE_A, ADMIN_USER);
  members.add(WORKSPACE_A, SALES_USER);
  members.add(WORKSPACE_A, OTHER_SALES_USER);
  members.add(WORKSPACE_A, VIEWER_USER);

  /** Stores a lead as if committed earlier. */
  const seed = (workspaceId: WorkspaceId, overrides: Partial<LeadState> = {}): LeadState => {
    const lead = aStoredLead(workspaceId, overrides);
    leads.seed(lead);
    return lead;
  };

  const auditActions = (): readonly string[] =>
    audit.entries.map((entry: AuditEntry) => `${entry.action}:${entry.result}`);

  return {
    log,
    registry,
    leads,
    activities,
    audit,
    stageOutbox,
    clock,
    ids,
    unitOfWork,
    leadReader,
    members,
    notes,
    idempotency,
    exportLock,
    exportReader,
    subjectData,
    gateway,
    planMac,
    changeLeadStage,
    assignLeadOwner,
    addLeadNote,
    exportLeadsCsv,
    exportLeadData,
    anonymizeLead,
    recordDenial,
    seed,
    auditActions,
  };
}

export type CommandHarness = ReturnType<typeof createCommandHarness>;
