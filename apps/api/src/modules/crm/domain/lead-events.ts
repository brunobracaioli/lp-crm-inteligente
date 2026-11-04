import type { LeadId, SubmissionId, UserId } from '#/shared/ids.ts';
import type { LeadStage, LostReason, ScoreBand } from '#/modules/crm/domain/lead-types.ts';
import type { Actor } from '#/modules/crm/domain/stage.ts';

interface LeadEventBase {
  readonly leadId: LeadId;
  readonly occurredAt: Date;
}

/** A submission was folded into the lead (creation or re-submission). */
export interface SubmissionRegistered extends LeadEventBase {
  readonly type: 'SubmissionRegistered';
  readonly submissionId: SubmissionId;
  readonly score: number;
  readonly scoreBand: ScoreBand;
  readonly submissionsCount: number;
}

/** Only emitted when an existing lead changes band (crm §5); never for a brand new lead. */
export interface ScoreChanged extends LeadEventBase {
  readonly type: 'ScoreChanged';
  readonly previousBand: ScoreBand;
  readonly scoreBand: ScoreBand;
  readonly score: number;
}

export interface StageChanged extends LeadEventBase {
  readonly type: 'StageChanged';
  readonly from: LeadStage;
  readonly to: LeadStage;
  readonly lostReason: LostReason | null;
  readonly by: Actor;
}

export interface OwnerAssigned extends LeadEventBase {
  readonly type: 'OwnerAssigned';
  readonly previousOwnerUserId: UserId | null;
  readonly ownerUserId: UserId | null;
  readonly by: Actor;
}

export interface LeadAnonymized extends LeadEventBase {
  readonly type: 'LeadAnonymized';
  readonly by: Actor;
}

export type LeadEvent =
  SubmissionRegistered | ScoreChanged | StageChanged | OwnerAssigned | LeadAnonymized;
