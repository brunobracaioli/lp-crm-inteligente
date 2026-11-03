/**
 * Ports of the `crm` application layer. Frozen in Onda 0: Onda 2 implements fakes and the use case,
 * Onda 4 implements Postgres adapters. Changing a port is a separate PR.
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
import type { AreaOfExpertise, AttributionSnapshot, CompanySize } from '#/shared/lead-profile.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

export type { Clock } from '#/shared/time.ts';
export type { IdGenerator } from '#/shared/ids.ts';
export type { Transaction } from '#/shared/unit-of-work.ts';

/** Persisted state of the Lead aggregate (crm.leads row). The aggregate maps to/from it. */
export interface LeadState {
  readonly id: LeadId;
  readonly workspaceId: WorkspaceId;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly whatsappE164: string;
  readonly companyName: string;
  readonly areaOfExpertise: AreaOfExpertise;
  readonly areaOfExpertiseOther: string | null;
  readonly jobTitle: string | null;
  readonly companySize: CompanySize | null;
  readonly companyWebsite: string | null;
  readonly stage: LeadStage;
  readonly lostReason: LostReason | null;
  readonly score: number;
  readonly scoreBand: ScoreBand;
  readonly scoreBreakdown: readonly ScoreContribution[];
  readonly ownerUserId: UserId | null;
  readonly marketingOptIn: boolean;
  readonly submissionsCount: number;
  readonly firstTouch: AttributionSnapshot;
  readonly lastTouch: AttributionSnapshot;
  readonly firstSubmittedAt: Date;
  readonly lastSubmittedAt: Date;
  readonly anonymizedAt: Date | null;
  /** Optimistic lock (crm §4: expected_version). */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LeadRepository {
  /**
   * `INSERT … ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL DO NOTHING`.
   * Race-safe: two tabs with the same e-mail yield one 'inserted' and one 'exists'.
   */
  insertIfAbsent(tx: Transaction, lead: LeadState): Promise<'inserted' | 'exists'>;
  /** Active (non-anonymized) lead by e-mail, row-locked until the transaction ends. */
  findActiveByEmailForUpdate(
    tx: Transaction,
    workspaceId: WorkspaceId,
    email: string,
  ): Promise<LeadState | null>;
  /** Writes `lead` only if the stored version equals `expectedVersion`; bumps the version. */
  update(
    tx: Transaction,
    lead: LeadState,
    expectedVersion: number,
  ): Promise<'updated' | 'version_conflict'>;
}

/** Append-only timeline row (crm.lead_activities). `data` holds IDs/codes only, ≤ 8 KB. */
export interface LeadActivityRecord {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly leadId: LeadId;
  readonly type: LeadActivityType;
  readonly actorType: ActorType;
  readonly actorId: UserId | null;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: Date;
}

export interface LeadActivityRepository {
  append(tx: Transaction, activity: LeadActivityRecord): Promise<void>;
}

/** Ideal customer profile used by score v1 (crm §5), from core.workspaces.settings.icp. */
export interface IcpSettings {
  readonly priorityAreas: readonly AreaOfExpertise[];
  readonly secondaryAreas: readonly AreaOfExpertise[];
  /** Normalized (lowercase, no accents) patterns matched against job_title. */
  readonly seniorTitlePatterns: readonly string[];
}

export interface IcpSettingsProvider {
  /** Returns null when the workspace has no ICP configured (the domain applies defaults). */
  getIcp(tx: Transaction, workspaceId: WorkspaceId): Promise<IcpSettings | null>;
}
