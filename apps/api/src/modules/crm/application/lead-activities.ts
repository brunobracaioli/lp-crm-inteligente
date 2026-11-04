import type { WorkspaceId } from '#/shared/ids.ts';
import type { LeadActivityRecord } from '#/modules/crm/application/ports.ts';
import type { LeadEvent } from '#/modules/crm/domain/lead-events.ts';
import type { Actor } from '#/modules/crm/domain/stage.ts';

type ActivityActor = Pick<LeadActivityRecord, 'actorType' | 'actorId'>;

function actorOf(by: Actor): ActivityActor {
  return by.type === 'user'
    ? { actorType: 'user', actorId: by.userId }
    : { actorType: 'system', actorId: null };
}

const SYSTEM_ACTOR: ActivityActor = { actorType: 'system', actorId: null };

/**
 * Maps a domain event to its append-only timeline row (database §3.6). `data` holds IDs and codes
 * only — never names, e-mails or phone numbers — and stays far below the 8 KB CHECK.
 */
export function activityForEvent(
  event: LeadEvent,
  workspaceId: WorkspaceId,
  id: string,
): LeadActivityRecord {
  const base = { id, workspaceId, leadId: event.leadId, createdAt: event.occurredAt };
  switch (event.type) {
    case 'SubmissionRegistered':
      return {
        ...base,
        ...SYSTEM_ACTOR,
        type: 'submission_received',
        data: {
          submission_id: event.submissionId,
          score: event.score,
          score_band: event.scoreBand,
          submissions_count: event.submissionsCount,
        },
      };
    case 'ScoreChanged':
      return {
        ...base,
        ...SYSTEM_ACTOR,
        type: 'score_changed',
        data: { from_band: event.previousBand, to_band: event.scoreBand, score: event.score },
      };
    case 'StageChanged':
      return {
        ...base,
        ...actorOf(event.by),
        type: 'stage_changed',
        data: { from: event.from, to: event.to, lost_reason: event.lostReason },
      };
    case 'OwnerAssigned':
      return {
        ...base,
        ...actorOf(event.by),
        type: 'owner_assigned',
        data: { previous_owner_id: event.previousOwnerUserId, owner_id: event.ownerUserId },
      };
    case 'LeadAnonymized':
      return { ...base, ...actorOf(event.by), type: 'anonymized', data: {} };
  }
}
