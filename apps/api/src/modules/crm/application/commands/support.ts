import type { CommandFailure } from '#/modules/crm/application/commands/failures.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import type { DomainError } from '#/modules/crm/domain/errors.ts';
import type { Actor } from '#/modules/crm/domain/stage.ts';
import type { AuditEntry, AuditResult } from '#/shared/audit.ts';
import type { CorrelationId } from '#/shared/ids.ts';

/**
 * `owner`/`admin` act on any lead; `sales` only on a lead they own or that has no owner
 * (crm §7, threat model C15). `viewer` never mutates.
 */
export function mayMutateLead(actor: StaffActor, lead: LeadState): boolean {
  switch (actor.role) {
    case 'owner':
    case 'admin':
      return true;
    case 'sales':
      return lead.ownerUserId === null || lead.ownerUserId === actor.userId;
    case 'viewer':
      return false;
  }
}

export function domainActor(actor: StaffActor): Actor {
  return { type: 'user', userId: actor.userId, role: actor.role };
}

export type AuditMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface AuditDraft {
  readonly actor: StaffActor;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly result: AuditResult;
  readonly correlationId: CorrelationId;
  readonly occurredAt: Date;
  /** IDs and codes only: never names, e-mails, phone numbers, note text or hashes. */
  readonly metadata?: AuditMetadata;
}

export function auditEntryOf(draft: AuditDraft): AuditEntry {
  return {
    workspaceId: draft.actor.workspaceId,
    occurredAt: draft.occurredAt,
    actorType: 'user',
    actorId: draft.actor.userId,
    action: draft.action,
    resourceType: draft.resourceType,
    resourceId: draft.resourceId,
    result: draft.result,
    correlationId: draft.correlationId,
    metadata: draft.metadata ?? {},
  };
}

/** Audit `resource_id` of an attempt whose target is not a valid lead id (column type `uuid`). */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A domain refusal the commands cannot map to a client-facing failure: a bug, rendered as 500. */
export class UnexpectedDomainErrorError extends Error {
  readonly code: string;

  constructor(error: DomainError) {
    super(`unexpected crm domain error: ${error.code}`);
    this.name = 'UnexpectedDomainErrorError';
    this.code = error.code;
  }
}

/** Maps a refusal of the Lead aggregate to the command failure the HTTP layer renders. */
export function failureOfDomainError(error: DomainError): CommandFailure {
  switch (error.code) {
    case 'invalid_stage_transition':
      return { code: 'invalid_stage_transition' };
    case 'lead_anonymized':
      return { code: 'lead_anonymized' };
    case 'reopen_not_allowed':
      return { code: 'forbidden' };
    case 'lost_reason_required':
      return { code: 'validation_failed', errors: [{ field: 'lost_reason', code: 'required' }] };
    case 'lost_reason_not_allowed':
      return { code: 'validation_failed', errors: [{ field: 'lost_reason', code: 'not_allowed' }] };
    case 'invalid_lost_reason':
      return {
        code: 'validation_failed',
        errors: [{ field: 'lost_reason', code: 'invalid_choice' }],
      };
    default:
      throw new UnexpectedDomainErrorError(error);
  }
}

/** The row we just updated under lock cannot be read back: RLS or the schema changed under us. */
export class LeadVanishedError extends Error {
  constructor() {
    super('lead disappeared inside its own transaction');
    this.name = 'LeadVanishedError';
  }
}
