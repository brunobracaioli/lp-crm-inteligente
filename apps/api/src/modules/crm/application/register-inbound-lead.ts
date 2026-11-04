import type { IdGenerator, LeadId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  IcpSettings,
  IcpSettingsProvider,
  LeadActivityRepository,
  LeadRepository,
  LeadState,
} from '#/modules/crm/application/ports.ts';
import { activityForEvent } from '#/modules/crm/application/lead-activities.ts';
import type { DomainErrorCode } from '#/modules/crm/domain/errors.ts';
import type { LeadEvent } from '#/modules/crm/domain/lead-events.ts';
import { Lead, type LeadChange } from '#/modules/crm/domain/lead.ts';
import type {
  RegisterInboundLead,
  RegisterInboundLeadCommand,
  RegisterInboundLeadResult,
} from '#/modules/crm/public-api.ts';

export interface RegisterInboundLeadDependencies {
  readonly leads: LeadRepository;
  readonly activities: LeadActivityRepository;
  readonly icp: IcpSettingsProvider;
  readonly ids: IdGenerator;
}

/**
 * The edge validated this data before calling the crm. A violation is a contract bug between the
 * modules, not a user error, so it aborts the caller's transaction instead of returning a result
 * (`RegisterInboundLead` has no error channel). Carries a code only: never PII.
 */
export class InboundLeadRejectedError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode) {
    super(`inbound lead rejected by the crm domain: ${code}`);
    this.name = 'InboundLeadRejectedError';
    this.code = code;
  }
}

/** Raised when the row lock or the unique index contradict each other (should be impossible). */
export class LeadStateInconsistentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadStateInconsistentError';
  }
}

/**
 * `RegisterInboundLead` (crm §6): inside the caller's transaction, folds a validated submission
 * into the lead of `(workspace, e-mail)` — creating it or updating the existing one — and writes
 * the `submission_received` (and, when the band moves, `score_changed`) activities.
 *
 * Race handling: two concurrent first submissions of the same e-mail both miss the initial
 * lookup; the unique index lets exactly one `insertIfAbsent` win, and the loser re-reads the
 * winner's row under a lock and takes the update path.
 */
export function createRegisterInboundLead(
  deps: RegisterInboundLeadDependencies,
): RegisterInboundLead {
  const recordActivities = async (
    tx: Transaction,
    command: RegisterInboundLeadCommand,
    events: readonly LeadEvent[],
  ): Promise<void> => {
    for (const event of events) {
      await deps.activities.append(
        tx,
        activityForEvent(event, command.workspaceId, deps.ids.uuidv7()),
      );
    }
  };

  const foldIntoExisting = async (
    tx: Transaction,
    existing: LeadState,
    command: RegisterInboundLeadCommand,
    icp: IcpSettings | null,
  ): Promise<RegisterInboundLeadResult> => {
    const change = unwrap(
      Lead.rehydrate(existing).registerSubmission(
        {
          submissionId: command.submissionId,
          occurredAt: command.occurredAt,
          contact: command.profile,
          attribution: command.attribution,
        },
        icp,
      ),
    );
    const outcome = await deps.leads.update(tx, change.lead.toProps(), existing.version);
    if (outcome === 'version_conflict') {
      throw new LeadStateInconsistentError('lead version changed while its row was locked');
    }
    await recordActivities(tx, command, change.events);
    return { leadId: change.lead.id, isNew: false, scoreBand: change.lead.scoreBand };
  };

  return async (tx, command) => {
    const { workspaceId, profile } = command;
    const icp = await deps.icp.getIcp(tx, workspaceId);

    const existing = await deps.leads.findActiveByEmailForUpdate(tx, workspaceId, profile.email);
    if (existing !== null) {
      return foldIntoExisting(tx, existing, command, icp);
    }

    const created = unwrap(
      Lead.register(
        {
          id: deps.ids.uuidv7() as LeadId,
          workspaceId,
          submissionId: command.submissionId,
          occurredAt: command.occurredAt,
          contact: profile,
          attribution: command.attribution,
        },
        icp,
      ),
    );
    if ((await deps.leads.insertIfAbsent(tx, created.lead.toProps())) === 'inserted') {
      await recordActivities(tx, command, created.events);
      return { leadId: created.lead.id, isNew: true, scoreBand: created.lead.scoreBand };
    }

    const winner = await deps.leads.findActiveByEmailForUpdate(tx, workspaceId, profile.email);
    if (winner === null) {
      throw new LeadStateInconsistentError('lead exists for the e-mail but cannot be read');
    }
    return foldIntoExisting(tx, winner, command, icp);
  };
}

function unwrap(
  result:
    | { readonly ok: true; readonly value: LeadChange }
    | { readonly ok: false; readonly error: { readonly code: DomainErrorCode } },
): LeadChange {
  if (!result.ok) {
    throw new InboundLeadRejectedError(result.error.code);
  }
  return result.value;
}
