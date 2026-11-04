import type {
  ActivityListQuery,
  ActivityView,
  AttributionSummaryView,
  ConsentView,
  KeysetPosition,
  LeadFilters,
  LeadListQuery,
  LeadProfileRecord,
  LeadProfileView,
  LeadQueries,
  LeadSummaryView,
  CursorCodec,
  Page,
  SubmissionView,
} from '#/modules/crm/application/queries/ports.ts';
import { createKeyedMac } from '#/platform/crypto/derived-key.ts';
import { createHmacCursorCodec } from '#/modules/crm/infrastructure/hmac-cursor-codec.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Clock } from '#/shared/time.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import { FakeUnitOfWork, TransactionRegistry } from './transactions.ts';

export const WORKSPACE_A = '0194f1c2-0000-7000-8000-00000000000a' as WorkspaceId;
export const WORKSPACE_B = '0194f1c2-0000-7000-8000-00000000000b' as WorkspaceId;
export const USER_A = '0194f1c2-1111-7000-8000-00000000000a' as UserId;
export const OTHER_USER = '0194f1c2-1111-7000-8000-00000000000c' as UserId;

const MICROSECOND_SUFFIX = '000Z';

export function positionOf(createdAt: Date, id: string): KeysetPosition {
  return { createdAt: createdAt.toISOString().replace(/Z$/, MICROSECOND_SUFFIX), id };
}

export const NO_TOUCH: AttributionSummaryView = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  utmId: null,
  landingPageUrl: null,
  referrerUrl: null,
  clickIdTypes: [],
};

/** A complete lead profile; `overrides` replace fields. */
export function aProfile(
  id: string,
  createdAt: Date,
  overrides: Partial<LeadProfileView> = {},
): LeadProfileView {
  return {
    id: id as LeadId,
    firstName: 'Carla',
    lastName: 'Menezes',
    email: `${id.slice(-12)}@acme.com.br`,
    companyName: 'Acme Ltda',
    jobTitle: 'Diretora Comercial',
    areaOfExpertise: 'technology',
    companySize: '51_200',
    stage: 'new',
    lostReason: null,
    score: 85,
    scoreBand: 'A',
    ownerUserId: null,
    submissionsCount: 1,
    firstSubmittedAt: createdAt,
    lastSubmittedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    anonymizedAt: null,
    version: 1,
    whatsappE164: '+5511912345678',
    areaOfExpertiseOther: null,
    companyWebsite: 'https://acme.com.br',
    marketingOptIn: true,
    scoreBreakdown: [{ ruleId: 'fit_size', points: 20 }],
    ...overrides,
  };
}

interface StoredLead {
  readonly workspaceId: WorkspaceId;
  readonly record: LeadProfileRecord;
  readonly submissions: readonly SubmissionView[];
  readonly consents: readonly ConsentView[];
  readonly activities: readonly ActivityView[];
}

function toSummary(profile: LeadProfileView): LeadSummaryView {
  return {
    id: profile.id,
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email,
    companyName: profile.companyName,
    jobTitle: profile.jobTitle,
    areaOfExpertise: profile.areaOfExpertise,
    companySize: profile.companySize,
    stage: profile.stage,
    lostReason: profile.lostReason,
    score: profile.score,
    scoreBand: profile.scoreBand,
    ownerUserId: profile.ownerUserId,
    submissionsCount: profile.submissionsCount,
    firstSubmittedAt: profile.firstSubmittedAt,
    lastSubmittedAt: profile.lastSubmittedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    anonymizedAt: profile.anonymizedAt,
    version: profile.version,
  };
}

const startsWith = (value: string, prefix: string): boolean =>
  value.toLowerCase().startsWith(prefix.toLowerCase());

function matches(profile: LeadProfileView, filters: LeadFilters): boolean {
  if (filters.stage !== null && profile.stage !== filters.stage) return false;
  if (filters.scoreBand !== null && profile.scoreBand !== filters.scoreBand) return false;
  if (filters.owner?.kind === 'unassigned' && profile.ownerUserId !== null) return false;
  if (filters.owner?.kind === 'user' && profile.ownerUserId !== filters.owner.userId) return false;
  const prefix = filters.prefix;
  if (prefix === null) return true;
  return [
    profile.firstName,
    profile.lastName,
    `${profile.firstName} ${profile.lastName}`,
    profile.companyName,
    profile.email,
  ].some((candidate) => startsWith(candidate, prefix));
}

/**
 * In-memory read model with the semantics of the Postgres adapter: workspace scoping, filters,
 * prefix match, `ORDER BY created_at DESC, id ASC|DESC` keysets and the 50/limit bounds.
 */
export class InMemoryLeadQueries implements LeadQueries {
  readonly #leads: StoredLead[] = [];
  /** Workspace scope of every call, to assert nothing runs unscoped. */
  readonly calls: { readonly method: string; readonly workspaceId: WorkspaceId }[] = [];

  addLead(
    workspaceId: WorkspaceId,
    profile: LeadProfileView,
    extras: {
      readonly firstTouch?: AttributionSummaryView;
      readonly lastTouch?: AttributionSummaryView;
      readonly submissions?: readonly SubmissionView[];
      readonly consents?: readonly ConsentView[];
      readonly activities?: readonly ActivityView[];
    } = {},
  ): void {
    this.#leads.push({
      workspaceId,
      record: {
        profile,
        firstTouch: extras.firstTouch ?? NO_TOUCH,
        lastTouch: extras.lastTouch ?? NO_TOUCH,
      },
      submissions: extras.submissions ?? [],
      consents: extras.consents ?? [],
      activities: extras.activities ?? [],
    });
  }

  listLeads(_tx: Transaction, query: LeadListQuery): Promise<Page<LeadSummaryView>> {
    this.calls.push({ method: 'listLeads', workspaceId: query.workspaceId });
    const ordered = this.#leads
      .filter((lead) => lead.workspaceId === query.workspaceId)
      .map((lead) => lead.record.profile)
      .filter((profile) => matches(profile, query.filters))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .filter((profile) => {
        const after = query.after;
        if (after === null) return true;
        const key = positionOf(profile.createdAt, profile.id);
        return (
          key.createdAt < after.createdAt ||
          (key.createdAt === after.createdAt && key.id > after.id)
        );
      });
    const items = ordered.slice(0, query.limit).map(toSummary);
    const last = items[items.length - 1];
    return Promise.resolve({
      items,
      next:
        ordered.length > query.limit && last !== undefined
          ? positionOf(last.createdAt, last.id)
          : null,
    });
  }

  findLeadProfile(
    _tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
  ): Promise<LeadProfileRecord | null> {
    this.calls.push({ method: 'findLeadProfile', workspaceId });
    const found = this.#leads.find(
      (lead) => lead.workspaceId === workspaceId && lead.record.profile.id === leadId,
    );
    return Promise.resolve(found?.record ?? null);
  }

  listSubmissions(
    _tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
    limit: number,
  ): Promise<readonly SubmissionView[]> {
    this.calls.push({ method: 'listSubmissions', workspaceId });
    const found = this.#leads.find(
      (lead) => lead.workspaceId === workspaceId && lead.record.profile.id === leadId,
    );
    return Promise.resolve((found?.submissions ?? []).slice(0, limit));
  }

  currentConsents(
    _tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
  ): Promise<readonly ConsentView[]> {
    this.calls.push({ method: 'currentConsents', workspaceId });
    const found = this.#leads.find(
      (lead) => lead.workspaceId === workspaceId && lead.record.profile.id === leadId,
    );
    return Promise.resolve(found?.consents ?? []);
  }

  listActivities(_tx: Transaction, query: ActivityListQuery): Promise<Page<ActivityView>> {
    this.calls.push({ method: 'listActivities', workspaceId: query.workspaceId });
    const found = this.#leads.find(
      (lead) => lead.workspaceId === query.workspaceId && lead.record.profile.id === query.leadId,
    );
    const ordered = [...(found?.activities ?? [])]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .filter((activity) => {
        const after = query.after;
        if (after === null) return true;
        const key = positionOf(activity.createdAt, activity.id);
        return (
          key.createdAt < after.createdAt ||
          (key.createdAt === after.createdAt && key.id < after.id)
        );
      });
    const items = ordered.slice(0, query.limit);
    const last = items[items.length - 1];
    return Promise.resolve({
      items,
      next:
        ordered.length > query.limit && last !== undefined
          ? positionOf(last.createdAt, last.id)
          : null,
    });
  }
}

export function aFakeUnitOfWork(): FakeUnitOfWork {
  return new FakeUnitOfWork(new TransactionRegistry(), []);
}

/** A throwaway pepper (32 bytes, base64): the suite never needs the real one. */
export const TEST_PEPPER = Buffer.alloc(32, 7).toString('base64');

export function aCursorCodec(clock: Pick<Clock, 'now'>, pepper: string = TEST_PEPPER): CursorCodec {
  return createHmacCursorCodec({ mac: createKeyedMac(pepper, 'crm-cursor-v1'), clock });
}
