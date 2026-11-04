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
import { parseNoteBody } from '#/modules/crm/application/commands/inputs.ts';
import type {
  LeadNoteReader,
  StaffActor,
  StoredNote,
} from '#/modules/crm/application/commands/ports.ts';
import { auditEntryOf, mayMutateLead } from '#/modules/crm/application/commands/support.ts';
import { codePointLength } from '#/shared/text.ts';
import type { CorrelationId, IdempotencyKey, LeadId } from '#/shared/ids.ts';
import { ok } from '#/shared/result.ts';

export interface AddLeadNoteDependencies extends MutationDependencies {
  readonly notes: LeadNoteReader;
}

export interface AddLeadNoteCommand {
  readonly actor: StaffActor;
  readonly leadId: LeadId;
  readonly body: RawBody;
  /** Mandatory for this operation: a retried note must never be written twice. */
  readonly idempotencyKey: IdempotencyKey | null;
  readonly correlationId: CorrelationId;
}

export type AddLeadNote = (command: AddLeadNoteCommand) => Promise<CommandResult<StoredNote>>;

const ACTION = 'lead.note_added';

/**
 * `POST /v1/crm/leads/{id}/notes` (contract `addLeadNote`): appends an immutable `note_added`
 * activity. The lead row is locked so a note can never slip in behind a concurrent anonymization.
 * A note does NOT assign the lead and does not bump its version. The audit row records the length
 * of the note, never its text.
 */
export function createAddLeadNote(deps: AddLeadNoteDependencies): AddLeadNote {
  const execute = (command: AddLeadNoteCommand): Promise<CommandResult<Executed<StoredNote>>> =>
    deps.unitOfWork.run(command.actor.workspaceId, async (tx) => {
      const { actor, leadId } = command;
      const lead = await deps.leads.findByIdForUpdate(tx, actor.workspaceId, leadId);
      if (lead === null) {
        return fail({ code: 'not_found' });
      }
      if (!mayMutateLead(actor, lead)) {
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
            metadata: { reason: 'not_owner' },
          }),
        );
        return fail({ code: 'forbidden' });
      }
      if (command.idempotencyKey === null) {
        return fail({ code: 'idempotency_key_missing' });
      }
      const text = parseNoteBody(command.body);
      if (!text.ok) {
        return text;
      }
      if (lead.anonymizedAt !== null) {
        return fail({ code: 'lead_anonymized' });
      }

      const occurredAt = deps.clock.now();
      const note: StoredNote = {
        id: deps.ids.uuidv7(),
        actorId: actor.userId,
        body: text.value,
        createdAt: occurredAt,
      };
      await deps.activities.append(tx, {
        id: note.id,
        workspaceId: actor.workspaceId,
        leadId,
        type: 'note_added',
        actorType: 'user',
        actorId: actor.userId,
        data: { body: note.body },
        createdAt: occurredAt,
      });
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
          metadata: { activity_id: note.id, length: codePointLength(note.body) },
        }),
      );
      return ok({ value: note, outcome: { kind: 'note', leadId, noteId: note.id } });
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
                operation: 'note',
                resourceId: command.leadId,
                key: command.idempotencyKey,
              }
            : null,
        requestHash: requestHashOf(
          'note',
          command.body.kind === 'json' ? command.body.value : null,
        ),
        // Without the store a retried note would be written twice and there is no database barrier.
        storeRequired: true,
        replay: async (outcome) =>
          outcome.kind === 'note'
            ? ((await deps.unitOfWork.run(command.actor.workspaceId, (tx) =>
                deps.notes.find(tx, command.actor.workspaceId, command.leadId, outcome.noteId),
              )) ?? undefined)
            : undefined,
      },
      () => execute(command),
    );
}
