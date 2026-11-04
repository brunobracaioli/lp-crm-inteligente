import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import {
  MAX_DETAIL_SUBMISSIONS,
  assertPageLimit,
} from '#/modules/crm/application/queries/pagination.ts';
import type {
  ActivityView,
  AttributionSummaryView,
  ConsentView,
  CursorCodec,
  CursorScope,
  KeysetPosition,
  LeadProfileView,
  LeadQueries,
  SubmissionView,
} from '#/modules/crm/application/queries/ports.ts';

export interface GetLeadDetailInput {
  /** From the authenticated principal, never from the request. */
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly leadId: LeadId;
  /** Already validated by the route: 1–100. */
  readonly activitiesLimit: number;
  /** `activities.next_cursor` of the previous activities page. */
  readonly activitiesCursor: string | null;
}

export interface LeadDetail {
  readonly lead: LeadProfileView;
  readonly firstTouch: AttributionSummaryView;
  readonly lastTouch: AttributionSummaryView;
  readonly submissions: readonly SubmissionView[];
  readonly consents: readonly ConsentView[];
  readonly activities: {
    readonly items: readonly ActivityView[];
    readonly nextCursor: string | null;
  };
}

/** `not_found` covers a nonexistent lead and a lead of another workspace alike (never 403). */
export type GetLeadDetailFailure =
  { readonly code: 'not_found' } | { readonly code: 'invalid_cursor' };

export interface GetLeadDetailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly queries: LeadQueries;
  readonly cursors: CursorCodec;
}

export type GetLeadDetail = (
  input: GetLeadDetailInput,
) => Promise<Result<LeadDetail, GetLeadDetailFailure>>;

/**
 * `GET /v1/crm/leads/{id}`: the lead, its 50 latest submissions (no IP/UA), the current consent per
 * purpose and one page of the timeline, all read in one transaction scoped to the principal's
 * workspace. The activities cursor is bound to this lead and user, so it cannot page another lead.
 */
export function createGetLeadDetail(deps: GetLeadDetailDependencies): GetLeadDetail {
  return async (input) => {
    assertPageLimit(input.activitiesLimit);
    const scope: CursorScope = {
      kind: 'activities',
      workspaceId: input.workspaceId,
      userId: input.userId,
      subject: input.leadId,
    };
    let after: KeysetPosition | null = null;
    if (input.activitiesCursor !== null) {
      after = deps.cursors.decode(scope, input.activitiesCursor);
      if (after === null) return err({ code: 'invalid_cursor' });
    }

    const loaded = await deps.unitOfWork.run(input.workspaceId, async (tx) => {
      const record = await deps.queries.findLeadProfile(tx, input.workspaceId, input.leadId);
      if (record === null) return null;
      const submissions = await deps.queries.listSubmissions(
        tx,
        input.workspaceId,
        input.leadId,
        MAX_DETAIL_SUBMISSIONS,
      );
      const consents = await deps.queries.currentConsents(tx, input.workspaceId, input.leadId);
      const activities = await deps.queries.listActivities(tx, {
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        limit: input.activitiesLimit,
        after,
      });
      return { record, submissions, consents, activities };
    });
    if (loaded === null) return err({ code: 'not_found' });

    const { record, submissions, consents, activities } = loaded;
    return ok({
      lead: record.profile,
      firstTouch: record.firstTouch,
      lastTouch: record.lastTouch,
      submissions,
      consents,
      activities: {
        items: activities.items,
        nextCursor: activities.next === null ? null : deps.cursors.encode(scope, activities.next),
      },
    });
  };
}
