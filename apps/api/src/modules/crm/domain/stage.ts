import type { UserId } from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import { domainError, type DomainError } from '#/modules/crm/domain/errors.ts';
import { LOST_REASONS, type LeadStage, type LostReason } from '#/modules/crm/domain/lead-types.ts';

/** Roles of `core.workspace_members` (database §3.10). */
export type MemberRole = 'owner' | 'admin' | 'sales' | 'viewer';

/** Who performs a state change. AI never changes stage, owner or score (crm §8.1). */
export type Actor =
  | { readonly type: 'system' }
  | { readonly type: 'user'; readonly userId: UserId; readonly role: MemberRole };

/**
 * The pipeline of crm §4. `new → qualified` is the only allowed skip (immediate qualification);
 * `won` is terminal; `lost` can only be reopened to `contacted`, and only by owner/admin.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<LeadStage, readonly LeadStage[]>> = {
  new: ['contacted', 'qualified', 'lost'],
  contacted: ['qualified', 'lost'],
  qualified: ['proposal', 'lost'],
  proposal: ['won', 'lost'],
  won: [],
  lost: ['contacted'],
};

const REOPEN_ROLES: readonly MemberRole[] = ['owner', 'admin'];

export interface StageChangeRequest {
  readonly from: LeadStage;
  readonly to: LeadStage;
  /** Untrusted when it comes from HTTP: the machine re-checks it against `LOST_REASONS`. */
  readonly lostReason: string | null;
  readonly by: Actor;
}

export interface StageChangePlan {
  readonly stage: LeadStage;
  /** Non-null exactly when `stage` is `lost` (database CHECK). */
  readonly lostReason: LostReason | null;
}

export function isLostReason(value: string): value is LostReason {
  return LOST_REASONS.some((reason) => reason === value);
}

function mayReopen(by: Actor): boolean {
  return by.type === 'user' && REOPEN_ROLES.includes(by.role);
}

/**
 * Validates a stage change against the state machine and returns the new stage/reason pair.
 * Order of checks: transition allowed → reopen privilege → lost reason consistency.
 */
export function planStageChange(request: StageChangeRequest): Result<StageChangePlan, DomainError> {
  const { from, to, lostReason, by } = request;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return err(domainError('invalid_stage_transition', `${from}->${to}`));
  }
  if (from === 'lost' && !mayReopen(by)) {
    return err(domainError('reopen_not_allowed'));
  }
  if (to === 'lost') {
    if (lostReason === null) {
      return err(domainError('lost_reason_required'));
    }
    if (!isLostReason(lostReason)) {
      return err(domainError('invalid_lost_reason'));
    }
    return ok({ stage: to, lostReason });
  }
  if (lostReason !== null) {
    return err(domainError('lost_reason_not_allowed'));
  }
  return ok({ stage: to, lostReason: null });
}
