/**
 * Read-side ports of the `crm` application layer (wave 9b): lead list, search and detail. They are
 * separate from `application/ports.ts` on purpose — the write side (aggregate repositories) and the
 * read models (projections for the staff UI) evolve independently, and no read model exposes
 * anything the contract's `LeadSummary`/`LeadProfile`/`LeadDetail` schemas do not name.
 */
import type {
  ActorType,
  LeadActivityType,
  LeadStage,
  LostReason,
  ScoreBand,
  ScoreContribution,
} from '#/modules/crm/domain/lead-types.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { AreaOfExpertise, CompanySize } from '#/shared/lead-profile.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

export const CLICK_ID_TYPES = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] as const;
export type ClickIdType = (typeof CLICK_ID_TYPES)[number];

export type ConsentPurpose = 'privacy_policy' | 'marketing_communications' | 'ad_tracking';
export type ConsentValue = 'granted' | 'denied';

/** Lead as it appears in lists (contract `LeadSummary`): no WhatsApp, no attribution, no message. */
export interface LeadSummaryView {
  readonly id: LeadId;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly companyName: string;
  readonly jobTitle: string | null;
  readonly areaOfExpertise: AreaOfExpertise;
  readonly companySize: CompanySize | null;
  readonly stage: LeadStage;
  readonly lostReason: LostReason | null;
  readonly score: number;
  readonly scoreBand: ScoreBand;
  readonly ownerUserId: UserId | null;
  readonly submissionsCount: number;
  readonly firstSubmittedAt: Date;
  readonly lastSubmittedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly anonymizedAt: Date | null;
  readonly version: number;
}

/** Contract `LeadProfile`: the summary plus the contact and score detail of the lead page. */
export interface LeadProfileView extends LeadSummaryView {
  readonly whatsappE164: string;
  readonly areaOfExpertiseOther: string | null;
  readonly companyWebsite: string | null;
  readonly marketingOptIn: boolean;
  readonly scoreBreakdown: readonly ScoreContribution[];
}

/** Contract `AttributionSummary`: no `fbp`/`fbc`/`ga_client_id`, click IDs only as types. */
export interface AttributionSummaryView {
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmTerm: string | null;
  readonly utmContent: string | null;
  readonly utmId: string | null;
  readonly landingPageUrl: string | null;
  readonly referrerUrl: string | null;
  readonly clickIdTypes: readonly ClickIdType[];
}

export interface LeadProfileRecord {
  readonly profile: LeadProfileView;
  readonly firstTouch: AttributionSummaryView;
  readonly lastTouch: AttributionSummaryView;
}

/** Contract `SubmissionFields`; a field the stored snapshot lacks (e.g. after anonymization) is null. */
export interface SubmissionFieldsView {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly whatsapp: string | null;
  readonly company: string | null;
  readonly areaOfExpertise: AreaOfExpertise | null;
  readonly areaOfExpertiseOther: string | null;
  readonly jobTitle: string | null;
  readonly companySize: CompanySize | null;
  readonly companyWebsite: string | null;
  readonly marketingOptIn: boolean | null;
}

export interface ConsentStateView {
  readonly analyticsStorage: ConsentValue | null;
  readonly adStorage: ConsentValue | null;
  readonly adUserData: ConsentValue | null;
  readonly adPersonalization: ConsentValue | null;
}

/** A submission as the salesperson sees it: never the IP, user agent, `fbp`/`fbc` or click ID values. */
export interface SubmissionView {
  readonly id: string;
  readonly createdAt: Date;
  readonly fields: SubmissionFieldsView;
  /** Free text typed by the visitor: untrusted, rendered as text only. */
  readonly message: string | null;
  readonly attribution: AttributionSummaryView;
  readonly consentState: ConsentStateView;
}

export interface ConsentView {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly recordedAt: Date;
}

export type ActivityDataValue = string | number | null;

export interface ActivityView {
  readonly id: string;
  readonly type: LeadActivityType;
  readonly actorType: ActorType;
  readonly actorId: UserId | null;
  readonly createdAt: Date;
  /** Keys are the contract's `ActivityData` properties (snake_case); unknown stored keys are dropped. */
  readonly data: Readonly<Record<string, ActivityDataValue>>;
}

/**
 * Keyset position of a row in a `(created_at, id)` ordering. `createdAt` is the UTC instant with
 * MICROSECOND precision (`YYYY-MM-DDTHH:MI:SS.uuuuuuZ`), because a JS `Date` would truncate to
 * milliseconds and break equality with the stored value.
 */
export interface KeysetPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Position of the last item when more rows exist; null at the end of the list. */
  readonly next: KeysetPosition | null;
}

export type OwnerFilter =
  { readonly kind: 'user'; readonly userId: UserId } | { readonly kind: 'unassigned' };

export interface LeadFilters {
  readonly stage: LeadStage | null;
  readonly owner: OwnerFilter | null;
  readonly scoreBand: ScoreBand | null;
  /** Normalized search term (prefix of name, company or e-mail); null = no text search. */
  readonly prefix: string | null;
}

export interface LeadListQuery {
  readonly workspaceId: WorkspaceId;
  readonly filters: LeadFilters;
  readonly limit: number;
  /** Rows strictly after this position in `ORDER BY created_at DESC, id ASC`. */
  readonly after: KeysetPosition | null;
}

export interface ActivityListQuery {
  readonly workspaceId: WorkspaceId;
  readonly leadId: LeadId;
  readonly limit: number;
  /** Rows strictly after this position in `ORDER BY created_at DESC, id DESC`. */
  readonly after: KeysetPosition | null;
}

/**
 * Read model over `crm.leads`, `crm.lead_activities` and (read-only, ADR-0008) `capture.submissions`
 * and `capture.consents`. Every method filters by `workspaceId` explicitly; RLS is the second barrier.
 */
export interface LeadQueries {
  listLeads(tx: Transaction, query: LeadListQuery): Promise<Page<LeadSummaryView>>;
  /** The lead in the workspace, or null (nonexistent and other-workspace are indistinguishable). */
  findLeadProfile(
    tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
  ): Promise<LeadProfileRecord | null>;
  /** Most recent first (`created_at DESC, id DESC`), at most `limit`. */
  listSubmissions(
    tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
    limit: number,
  ): Promise<readonly SubmissionView[]>;
  /** The latest record per purpose. */
  currentConsents(
    tx: Transaction,
    workspaceId: WorkspaceId,
    leadId: LeadId,
  ): Promise<readonly ConsentView[]>;
  listActivities(tx: Transaction, query: ActivityListQuery): Promise<Page<ActivityView>>;
}

/**
 * What a signed cursor is bound to. A cursor only decodes for the same kind, workspace, user and
 * subject (the filter fingerprint of a list, the lead id of an activity timeline).
 */
export interface CursorScope {
  readonly kind: 'leads' | 'activities';
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly subject: string;
}

export interface CursorCodec {
  encode(scope: CursorScope, position: KeysetPosition): string;
  /** null for any token that is malformed, tampered, expired or minted for another scope. */
  decode(scope: CursorScope, token: string): KeysetPosition | null;
}
