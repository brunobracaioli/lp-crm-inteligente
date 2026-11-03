/**
 * Public interface of the `tracking` bounded context (tracking §5, ADR-0004).
 * Frozen in Onda 0. Other modules import ONLY this file.
 */
import type {
  CorrelationId,
  LeadId,
  OutboxEventId,
  SubmissionId,
  WorkspaceId,
} from '#/shared/ids.ts';

export type OutboxEventType = 'lead.captured' | 'lead.stage_changed';

/** Payload of `lead.captured`: IDs only, never PII (database §3.7). */
export interface LeadCapturedPayload {
  readonly lead_id: LeadId;
  readonly submission_id: SubmissionId;
}

/** Row to insert into tracking.outbox_events in the caller's transaction (R6). */
export interface OutboxEventDraft {
  readonly id: OutboxEventId;
  readonly workspaceId: WorkspaceId;
  readonly aggregateType: 'lead';
  readonly aggregateId: LeadId;
  readonly eventType: 'lead.captured';
  readonly payload: LeadCapturedPayload;
  readonly createdAt: Date;
}

/**
 * Called after COMMIT to publish the event to QStash in the background (`waitUntil`).
 * Must never throw or delay the response; failures are covered by the sweeper (tracking §5.1).
 */
export type TriggerOutboxDispatch = (
  outboxEventId: OutboxEventId,
  correlationId: CorrelationId,
) => void;
