import { activityForEvent } from '#/modules/crm/application/lead-activities.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import type { MutationDependencies } from '#/modules/crm/application/commands/dependencies.ts';
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
import { parseStageChangeBody } from '#/modules/crm/application/commands/inputs.ts';
import type {
  ConversionStage,
  StageChangeOutbox,
  StaffActor,
} from '#/modules/crm/application/commands/ports.ts';
import {
  auditEntryOf,
  domainActor,
  failureOfDomainError,
  LeadVanishedError,
  mayMutateLead,
} from '#/modules/crm/application/commands/support.ts';
import { Lead, type LeadChange } from '#/modules/crm/domain/lead.ts';
import type { CorrelationId, IdempotencyKey, LeadId } from '#/shared/ids.ts';
import { err, ok } from '#/shared/result.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

export interface ChangeLeadStageDependencies extends MutationDependencies {
  /**
   * Enqueues `lead.stage_changed` for `qualified` and `won` (offline conversions, crm §4). Leave it
   * out until the tracking dispatcher handles that event type (Onda 11b): today it dead-letters it.
   */
  readonly stageOutbox?: StageChangeOutbox;
}

export interface ChangeLeadStageCommand {
  readonly actor: StaffActor;
  readonly leadId: LeadId;
  readonly body: RawBody;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly correlationId: CorrelationId;
}

export type ChangeLeadStage = (
  command: ChangeLeadStageCommand,
) => Promise<CommandResult<LeadState>>;

const ACTION = 'lead.stage_changed';
const CONVERSION_STAGES: readonly string[] = ['qualified', 'won'] satisfies ConversionStage[];

function isConversionStage(stage: string): stage is ConversionStage {
  return CONVERSION_STAGES.includes(stage);
}

/**
 * `PATCH /v1/crm/leads/{id}/stage` (crm §4, contract `changeLeadStage`). One transaction: lock the
 * lead → per-resource rule → body → anonymized/version/transition → write + timeline + outbox +
 * audit. A `sales` user changing an unowned lead becomes its owner (G6), in the same commit.
 */
export function createChangeLeadStage(deps: ChangeLeadStageDependencies): ChangeLeadStage {
  const deny = async (
    tx: Transaction,
    command: ChangeLeadStageCommand,
    reason: string,
  ): Promise<void> => {
    await deps.audit.append(
      tx,
      auditEntryOf({
        actor: command.actor,
        action: ACTION,
        resourceType: 'lead',
        resourceId: command.leadId,
        result: 'denied',
        correlationId: command.correlationId,
        occurredAt: deps.clock.now(),
        metadata: { reason },
      }),
    );
  };

  const apply = (
    tx: Transaction,
    command: ChangeLeadStageCommand,
    current: LeadState,
  ): Promise<CommandResult<Executed<LeadState>>> =>
    applyStageChange(deps, tx, command, current, deny);

  const execute = (command: ChangeLeadStageCommand): Promise<CommandResult<Executed<LeadState>>> =>
    deps.unitOfWork.run(command.actor.workspaceId, async (tx) => {
      const current = await deps.leads.findByIdForUpdate(
        tx,
        command.actor.workspaceId,
        command.leadId,
      );
      if (current === null) {
        return fail({ code: 'not_found' });
      }
      if (!mayMutateLead(command.actor, current)) {
        await deny(tx, command, 'not_owner');
        return fail({ code: 'forbidden' });
      }
      return apply(tx, command, current);
    });

  return (command) =>
    runIdempotent(
      {
        store: deps.idempotency,
        scope:
          command.idempotencyKey !== null && command.body.kind === 'json'
            ? {
                workspaceId: command.actor.workspaceId,
                userId: command.actor.userId,
                operation: 'stage',
                resourceId: command.leadId,
                key: command.idempotencyKey,
              }
            : null,
        requestHash: requestHashOf(
          'stage',
          command.body.kind === 'json' ? command.body.value : null,
        ),
        storeRequired: false,
        replay: async (outcome) =>
          outcome.kind === 'lead'
            ? ((await deps.unitOfWork.run(command.actor.workspaceId, (tx) =>
                deps.leads.findById(tx, command.actor.workspaceId, command.leadId),
              )) ?? undefined)
            : undefined,
      },
      () => execute(command),
    );
}

async function applyStageChange(
  deps: ChangeLeadStageDependencies,
  tx: Transaction,
  command: ChangeLeadStageCommand,
  current: LeadState,
  deny: (tx: Transaction, command: ChangeLeadStageCommand, reason: string) => Promise<void>,
): Promise<CommandResult<Executed<LeadState>>> {
  const input = parseStageChangeBody(command.body);
  if (!input.ok) {
    return input;
  }
  const { toStage, lostReason, expectedVersion } = input.value;
  if (current.anonymizedAt !== null) {
    return fail({ code: 'lead_anonymized' });
  }
  if (current.version !== expectedVersion) {
    return fail({ code: 'version_conflict' });
  }

  const occurredAt = deps.clock.now();
  const by = domainActor(command.actor);
  const autoAssign = command.actor.role === 'sales' && current.ownerUserId === null;
  const lead = Lead.rehydrate(current);

  const assigned: LeadChange | null = autoAssign
    ? unwrapChange(lead.assignOwner({ ownerUserId: command.actor.userId, by, occurredAt }))
    : null;
  const staged = (assigned?.lead ?? lead).changeStage({ to: toStage, by, lostReason, occurredAt });
  if (!staged.ok) {
    if (staged.error.code === 'reopen_not_allowed') {
      await deny(tx, command, 'reopen_not_allowed');
    }
    return err(failureOfDomainError(staged.error));
  }

  const written = await deps.leadWriter.update(tx, staged.value.lead.toProps(), expectedVersion);
  if (written === 'version_conflict') {
    return fail({ code: 'version_conflict' });
  }
  const events = [...(assigned?.events ?? []), ...staged.value.events];
  for (const event of events) {
    await deps.activities.append(
      tx,
      activityForEvent(event, command.actor.workspaceId, deps.ids.uuidv7()),
    );
  }
  if (deps.stageOutbox !== undefined && isConversionStage(toStage)) {
    await deps.stageOutbox.enqueue(tx, {
      workspaceId: command.actor.workspaceId,
      leadId: command.leadId,
      toStage,
      occurredAt,
    });
  }
  await deps.audit.append(
    tx,
    auditEntryOf({
      actor: command.actor,
      action: ACTION,
      resourceType: 'lead',
      resourceId: command.leadId,
      result: 'success',
      correlationId: command.correlationId,
      occurredAt,
      metadata: {
        from_stage: current.stage,
        to_stage: toStage,
        lost_reason: lostReason,
        auto_assigned: autoAssign,
        version: expectedVersion + 1,
      },
    }),
  );
  const saved = await deps.leads.findById(tx, command.actor.workspaceId, command.leadId);
  if (saved === null) {
    throw new LeadVanishedError();
  }
  return ok({
    value: saved,
    outcome: { kind: 'lead', leadId: saved.id, version: saved.version },
  });
}

function unwrapChange(result: ReturnType<Lead['assignOwner']>): LeadChange {
  if (!result.ok) {
    throw new Error(`assigning the owner of an active lead failed: ${result.error.code}`);
  }
  return result.value;
}
