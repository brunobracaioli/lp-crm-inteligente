import {
  erasureItems,
  fingerprintOf,
  issuePlan,
  verifyPlan,
  WILL_KEEP,
  type ErasureItem,
  type PlanSubject,
} from '#/modules/crm/application/commands/anonymization-plan.ts';
import {
  fail,
  type CommandResult,
  type RawBody,
} from '#/modules/crm/application/commands/failures.ts';
import {
  requestHashOf,
  runIdempotent,
  type Executed,
} from '#/modules/crm/application/commands/idempotent.ts';
import {
  bodyRequestsConfirmation,
  parseAnonymizeBody,
} from '#/modules/crm/application/commands/inputs.ts';
import type {
  AnonymizationGateway,
  LeadReader,
  StaffActor,
  StaffIdempotencyStore,
} from '#/modules/crm/application/commands/ports.ts';
import { auditEntryOf, LeadVanishedError } from '#/modules/crm/application/commands/support.ts';
import type { KeyedMac } from '#/platform/crypto/derived-key.ts';
import type { AuditLogWriter } from '#/shared/audit.ts';
import type { CorrelationId, IdempotencyKey, LeadId } from '#/shared/ids.ts';
import { ok } from '#/shared/result.ts';
import type { Clock } from '#/shared/time.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

export interface AnonymizationPreview {
  readonly mode: 'preview';
  readonly leadId: LeadId;
  readonly leadVersion: number;
  readonly planHash: string;
  readonly expiresAt: Date;
  readonly willErase: readonly ErasureItem[];
  readonly willKeep: typeof WILL_KEEP;
}

export interface AnonymizationApplied {
  readonly mode: 'applied';
  readonly leadId: LeadId;
  readonly anonymizedAt: Date;
  readonly version: number;
}

export type AnonymizeOutcome = AnonymizationPreview | AnonymizationApplied;

export interface AnonymizeLeadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly leads: LeadReader;
  readonly gateway: AnonymizationGateway;
  readonly audit: AuditLogWriter;
  readonly idempotency: StaffIdempotencyStore;
  /** `createKeyedMac(pepper, 'crm-plan-v1')`. */
  readonly planMac: KeyedMac;
  readonly clock: Clock;
}

export interface AnonymizeLeadCommand {
  readonly actor: StaffActor;
  readonly leadId: LeadId;
  readonly body: RawBody;
  /** Required when the body confirms; a preview needs none. */
  readonly idempotencyKey: IdempotencyKey | null;
  readonly correlationId: CorrelationId;
}

export type AnonymizeLead = (
  command: AnonymizeLeadCommand,
) => Promise<CommandResult<AnonymizeOutcome>>;

const PREVIEW_ACTION = 'lead.anonymize_previewed';
const APPLY_ACTION = 'lead.anonymized';

function isAdmin(actor: StaffActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin';
}

/**
 * `POST /v1/crm/leads/{id}/anonymize` (LGPD erasure, contract `anonymizeLead`), preview-first.
 *
 * - Preview (`confirm` absent/false): reads, never writes the lead; returns what will be erased and a
 *   `plan_hash` (stateless MAC over lead, version, requester, inventory fingerprint and expiry).
 * - Apply (`confirm: true` + `plan_hash`): locks the lead, recomputes the inventory, requires the
 *   hash to match this exact state and user (else `409 plan_stale`, nothing changes), then runs
 *   `crm.anonymize_lead` and audits in the same transaction. Idempotent per key: a replay returns
 *   the stored `applied` result without touching the database.
 */
export function createAnonymizeLead(deps: AnonymizeLeadDependencies): AnonymizeLead {
  const preview = (command: AnonymizeLeadCommand): Promise<CommandResult<AnonymizeOutcome>> =>
    previewAnonymization(deps, command);

  const apply = (command: AnonymizeLeadCommand): Promise<CommandResult<AnonymizeOutcome>> =>
    runIdempotent<AnonymizeOutcome>(
      {
        store: deps.idempotency,
        scope:
          command.idempotencyKey !== null && command.body.kind === 'json'
            ? {
                workspaceId: command.actor.workspaceId,
                userId: command.actor.userId,
                operation: 'anonymize',
                resourceId: command.leadId,
                key: command.idempotencyKey,
              }
            : null,
        requestHash: requestHashOf(
          'anonymize',
          command.body.kind === 'json' ? command.body.value : null,
        ),
        storeRequired: false,
        replay: (outcome) =>
          Promise.resolve(
            outcome.kind === 'anonymized'
              ? {
                  mode: 'applied' as const,
                  leadId: outcome.leadId as LeadId,
                  anonymizedAt: new Date(outcome.anonymizedAt),
                  version: outcome.version,
                }
              : undefined,
          ),
      },
      () => applyAnonymization(deps, command),
    );

  return (command) => (bodyRequestsConfirmation(command.body) ? apply(command) : preview(command));
}

async function previewAnonymization(
  deps: AnonymizeLeadDependencies,
  command: AnonymizeLeadCommand,
): Promise<CommandResult<AnonymizeOutcome>> {
  const { actor, leadId } = command;
  if (!isAdmin(actor)) {
    return fail({ code: 'forbidden' });
  }
  return deps.unitOfWork.run(actor.workspaceId, async (tx) => {
    const lead = await deps.leads.findById(tx, actor.workspaceId, leadId);
    if (lead === null) {
      return fail({ code: 'not_found' });
    }
    const input = parseAnonymizeBody(command.body);
    if (!input.ok) {
      return input;
    }
    if (lead.anonymizedAt !== null) {
      return fail({ code: 'lead_anonymized' });
    }
    const now = deps.clock.now();
    const items = erasureItems(lead, await deps.gateway.inventory(tx, actor.workspaceId, leadId));
    const plan = issuePlan(
      deps.planMac,
      subjectOf(actor, leadId, lead.version, fingerprintOf(items)),
      now,
    );
    await deps.audit.append(
      tx,
      auditEntryOf({
        actor,
        action: PREVIEW_ACTION,
        resourceType: 'lead',
        resourceId: leadId,
        result: 'success',
        correlationId: command.correlationId,
        occurredAt: now,
        metadata: { lead_version: lead.version },
      }),
    );
    return ok({
      mode: 'preview',
      leadId,
      leadVersion: lead.version,
      planHash: plan.planHash,
      expiresAt: plan.expiresAt,
      willErase: items,
      willKeep: WILL_KEEP,
    });
  });
}

async function applyAnonymization(
  deps: AnonymizeLeadDependencies,
  command: AnonymizeLeadCommand,
): Promise<CommandResult<Executed<AnonymizeOutcome>>> {
  const { actor, leadId } = command;
  if (!isAdmin(actor)) {
    return fail({ code: 'forbidden' });
  }
  return deps.unitOfWork.run(actor.workspaceId, async (tx) => {
    const lead = await deps.leads.findByIdForUpdate(tx, actor.workspaceId, leadId);
    if (lead === null) {
      return fail({ code: 'not_found' });
    }
    const input = parseAnonymizeBody(command.body);
    if (!input.ok) {
      return input;
    }
    if (!input.value.confirm) {
      // The body changed between the dispatch and the parse: only a preview can reach here.
      return fail({ code: 'plan_stale' });
    }
    if (command.idempotencyKey === null) {
      return fail({ code: 'idempotency_key_missing' });
    }
    if (lead.anonymizedAt !== null) {
      return fail({ code: 'lead_anonymized' });
    }
    const now = deps.clock.now();
    const items = erasureItems(lead, await deps.gateway.inventory(tx, actor.workspaceId, leadId));
    const subject = subjectOf(actor, leadId, lead.version, fingerprintOf(items));
    if (!verifyPlan(deps.planMac, subject, input.value.planHash, now)) {
      return fail({ code: 'plan_stale' });
    }

    const anonymized = await deps.gateway.anonymize(tx, leadId, actor, command.correlationId);
    if (!anonymized) {
      return fail({ code: 'lead_anonymized' });
    }
    const saved = await deps.leads.findById(tx, actor.workspaceId, leadId);
    if (saved?.anonymizedAt == null) {
      throw new LeadVanishedError();
    }
    await deps.audit.append(
      tx,
      auditEntryOf({
        actor,
        action: APPLY_ACTION,
        resourceType: 'lead',
        resourceId: leadId,
        result: 'success',
        correlationId: command.correlationId,
        occurredAt: now,
        metadata: { lead_version: lead.version, resulting_version: saved.version },
      }),
    );
    return ok({
      value: {
        mode: 'applied',
        leadId,
        anonymizedAt: saved.anonymizedAt,
        version: saved.version,
      },
      outcome: {
        kind: 'anonymized',
        leadId,
        anonymizedAt: saved.anonymizedAt.toISOString(),
        version: saved.version,
      },
    });
  });
}

function subjectOf(
  actor: StaffActor,
  leadId: LeadId,
  version: number,
  fingerprint: string,
): PlanSubject {
  return { workspaceId: actor.workspaceId, leadId, version, userId: actor.userId, fingerprint };
}
