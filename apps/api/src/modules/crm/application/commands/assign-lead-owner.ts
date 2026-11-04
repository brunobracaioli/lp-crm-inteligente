import { activityForEvent } from '#/modules/crm/application/lead-activities.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import type { MutationDependencies } from '#/modules/crm/application/commands/dependencies.ts';
import {
  fail,
  invalidField,
  type CommandResult,
  type RawBody,
} from '#/modules/crm/application/commands/failures.ts';
import {
  requestHashOf,
  runIdempotent,
  type Executed,
} from '#/modules/crm/application/commands/idempotent.ts';
import { parseOwnerChangeBody } from '#/modules/crm/application/commands/inputs.ts';
import type { MemberDirectory, StaffActor } from '#/modules/crm/application/commands/ports.ts';
import {
  auditEntryOf,
  domainActor,
  failureOfDomainError,
  LeadVanishedError,
} from '#/modules/crm/application/commands/support.ts';
import { Lead } from '#/modules/crm/domain/lead.ts';
import type { CorrelationId, IdempotencyKey, LeadId } from '#/shared/ids.ts';
import { err, ok } from '#/shared/result.ts';

export interface AssignLeadOwnerDependencies extends MutationDependencies {
  readonly members: MemberDirectory;
}

export interface AssignLeadOwnerCommand {
  readonly actor: StaffActor;
  readonly leadId: LeadId;
  readonly body: RawBody;
  readonly idempotencyKey: IdempotencyKey | null;
  readonly correlationId: CorrelationId;
}

export type AssignLeadOwner = (
  command: AssignLeadOwnerCommand,
) => Promise<CommandResult<LeadState>>;

const ACTION = 'lead.owner_assigned';

/**
 * `PATCH /v1/crm/leads/{id}/owner` (contract `assignLeadOwner`): `owner`/`admin` only. The target
 * must be an active member of the credential's workspace — a missing user and a member of another
 * workspace are indistinguishable (`owner_user_id`/`invalid_choice`, C19). Re-assigning the current
 * owner changes nothing (no version bump, no timeline row) but is still audited.
 */
export function createAssignLeadOwner(deps: AssignLeadOwnerDependencies): AssignLeadOwner {
  const execute = (command: AssignLeadOwnerCommand): Promise<CommandResult<Executed<LeadState>>> =>
    deps.unitOfWork.run(command.actor.workspaceId, async (tx) => {
      const { actor, leadId } = command;
      const current = await deps.leads.findByIdForUpdate(tx, actor.workspaceId, leadId);
      if (current === null) {
        return fail({ code: 'not_found' });
      }
      if (actor.role !== 'owner' && actor.role !== 'admin') {
        await deps.audit.append(
          tx,
          auditEntryOf({
            actor,
            action: ACTION,
            resourceType: 'lead',
            resourceId: leadId,
            result: 'denied',
            correlationId: command.correlationId,
            occurredAt: deps.clock.now(),
            metadata: { reason: 'role' },
          }),
        );
        return fail({ code: 'forbidden' });
      }
      const input = parseOwnerChangeBody(command.body);
      if (!input.ok) {
        return input;
      }
      const { ownerUserId, expectedVersion } = input.value;
      if (
        ownerUserId !== null &&
        !(await deps.members.isActiveMember(tx, actor.workspaceId, ownerUserId))
      ) {
        return invalidField('owner_user_id', 'invalid_choice');
      }
      if (current.anonymizedAt !== null) {
        return fail({ code: 'lead_anonymized' });
      }
      if (current.version !== expectedVersion) {
        return fail({ code: 'version_conflict' });
      }

      const occurredAt = deps.clock.now();
      const changed = Lead.rehydrate(current).assignOwner({
        ownerUserId,
        by: domainActor(actor),
        occurredAt,
      });
      if (!changed.ok) {
        return err(failureOfDomainError(changed.error));
      }
      const unchanged = changed.value.events.length === 0;
      if (!unchanged) {
        const written = await deps.leadWriter.update(
          tx,
          changed.value.lead.toProps(),
          expectedVersion,
        );
        if (written === 'version_conflict') {
          return fail({ code: 'version_conflict' });
        }
        for (const event of changed.value.events) {
          await deps.activities.append(
            tx,
            activityForEvent(event, actor.workspaceId, deps.ids.uuidv7()),
          );
        }
      }
      await deps.audit.append(
        tx,
        auditEntryOf({
          actor,
          action: ACTION,
          resourceType: 'lead',
          resourceId: leadId,
          result: 'success',
          correlationId: command.correlationId,
          occurredAt,
          metadata: {
            from_owner_user_id: current.ownerUserId,
            to_owner_user_id: ownerUserId,
            changed: !unchanged,
          },
        }),
      );
      const saved = await deps.leads.findById(tx, actor.workspaceId, leadId);
      if (saved === null) {
        throw new LeadVanishedError();
      }
      return ok({
        value: saved,
        outcome: { kind: 'lead', leadId: saved.id, version: saved.version },
      });
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
                operation: 'owner',
                resourceId: command.leadId,
                key: command.idempotencyKey,
              }
            : null,
        requestHash: requestHashOf(
          'owner',
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
