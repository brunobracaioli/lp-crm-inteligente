import { describe, expect, it } from 'vitest';
import type { LeadId, SubmissionId, UserId, WorkspaceId } from '#/shared/ids.ts';
import { activityForEvent } from '#/modules/crm/application/lead-activities.ts';
import type { LeadEvent } from '#/modules/crm/domain/lead-events.ts';
import type { Actor } from '#/modules/crm/domain/stage.ts';

const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000b1' as WorkspaceId;
const LEAD_ID = '00000000-0000-7000-8000-0000000000a1' as LeadId;
const USER_ID = '00000000-0000-7000-8000-0000000000d1' as UserId;
const OTHER_USER_ID = '00000000-0000-7000-8000-0000000000d2' as UserId;
const AT = new Date('2026-11-03T12:00:00.000Z');
const ACTIVITY_ID = '00000000-0000-7000-8000-0000000000e1';

const user: Actor = { type: 'user', userId: USER_ID, role: 'admin' };
const system: Actor = { type: 'system' };

describe('activityForEvent', () => {
  it('maps SubmissionRegistered to a system submission_received row with IDs and counters only', () => {
    // arrange
    const event: LeadEvent = {
      type: 'SubmissionRegistered',
      leadId: LEAD_ID,
      occurredAt: AT,
      submissionId: '00000000-0000-7000-8000-0000000000c1' as SubmissionId,
      score: 45,
      scoreBand: 'B',
      submissionsCount: 2,
    };
    // act
    const activity = activityForEvent(event, WORKSPACE_ID, ACTIVITY_ID);
    // assert
    expect(activity).toEqual({
      id: ACTIVITY_ID,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      type: 'submission_received',
      actorType: 'system',
      actorId: null,
      createdAt: AT,
      data: {
        submission_id: '00000000-0000-7000-8000-0000000000c1',
        score: 45,
        score_band: 'B',
        submissions_count: 2,
      },
    });
  });

  it('maps ScoreChanged to a system score_changed row', () => {
    const activity = activityForEvent(
      {
        type: 'ScoreChanged',
        leadId: LEAD_ID,
        occurredAt: AT,
        previousBand: 'C',
        scoreBand: 'B',
        score: 40,
      },
      WORKSPACE_ID,
      ACTIVITY_ID,
    );
    expect(activity).toMatchObject({
      type: 'score_changed',
      actorType: 'system',
      data: { from_band: 'C', to_band: 'B', score: 40 },
    });
  });

  it.each([
    ['a user', user, { actorType: 'user', actorId: USER_ID }],
    ['the system', system, { actorType: 'system', actorId: null }],
  ])('maps StageChanged performed by %s', (_label, by, actor) => {
    const activity = activityForEvent(
      {
        type: 'StageChanged',
        leadId: LEAD_ID,
        occurredAt: AT,
        from: 'proposal',
        to: 'lost',
        lostReason: 'timing',
        by,
      },
      WORKSPACE_ID,
      ACTIVITY_ID,
    );
    expect(activity).toMatchObject({
      type: 'stage_changed',
      ...actor,
      data: { from: 'proposal', to: 'lost', lost_reason: 'timing' },
    });
  });

  it('maps OwnerAssigned with the previous and the new owner', () => {
    const activity = activityForEvent(
      {
        type: 'OwnerAssigned',
        leadId: LEAD_ID,
        occurredAt: AT,
        previousOwnerUserId: OTHER_USER_ID,
        ownerUserId: null,
        by: user,
      },
      WORKSPACE_ID,
      ACTIVITY_ID,
    );
    expect(activity).toMatchObject({
      type: 'owner_assigned',
      actorType: 'user',
      actorId: USER_ID,
      data: { previous_owner_id: OTHER_USER_ID, owner_id: null },
    });
  });

  it('maps LeadAnonymized to an anonymized row with no data', () => {
    const activity = activityForEvent(
      { type: 'LeadAnonymized', leadId: LEAD_ID, occurredAt: AT, by: user },
      WORKSPACE_ID,
      ACTIVITY_ID,
    );
    expect(activity).toMatchObject({ type: 'anonymized', actorId: USER_ID, data: {} });
  });
});
