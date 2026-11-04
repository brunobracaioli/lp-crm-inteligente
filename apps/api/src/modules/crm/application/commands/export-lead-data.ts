import { fail, type CommandResult } from '#/modules/crm/application/commands/failures.ts';
import type {
  LeadReader,
  StaffActor,
  SubjectDataBundle,
  SubjectDataReader,
} from '#/modules/crm/application/commands/ports.ts';
import { auditEntryOf } from '#/modules/crm/application/commands/support.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import type { AuditLogWriter } from '#/shared/audit.ts';
import type { CorrelationId, LeadId } from '#/shared/ids.ts';
import { ok } from '#/shared/result.ts';
import type { Clock } from '#/shared/time.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

export interface LeadSubjectExport {
  readonly lead: LeadState;
  readonly data: SubjectDataBundle;
  readonly exportedAt: Date;
}

export interface ExportLeadDataDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly leads: LeadReader;
  readonly subjectData: SubjectDataReader;
  readonly audit: AuditLogWriter;
  readonly clock: Clock;
}

export interface ExportLeadDataCommand {
  readonly actor: StaffActor;
  readonly leadId: LeadId;
  readonly correlationId: CorrelationId;
}

export type ExportLeadData = (
  command: ExportLeadDataCommand,
) => Promise<CommandResult<LeadSubjectExport>>;

const ACTION = 'lead.data_exported';

/**
 * `GET /v1/crm/leads/{id}/data-export` (LGPD right of access, contract `exportLeadSubjectData`).
 * Read and audit share a transaction: data never leaves without its audit row. An anonymized lead
 * has no personal data left to deliver (`409 lead_anonymized`). The audit metadata carries the
 * counts of what was delivered, nothing of its content.
 */
export function createExportLeadData(deps: ExportLeadDataDependencies): ExportLeadData {
  return (command) =>
    deps.unitOfWork.run(command.actor.workspaceId, async (tx) => {
      const { actor, leadId } = command;
      if (actor.role !== 'owner' && actor.role !== 'admin') {
        return fail({ code: 'forbidden' });
      }
      const lead = await deps.leads.findById(tx, actor.workspaceId, leadId);
      if (lead === null) {
        return fail({ code: 'not_found' });
      }
      if (lead.anonymizedAt !== null) {
        return fail({ code: 'lead_anonymized' });
      }
      const data = await deps.subjectData.read(tx, actor.workspaceId, leadId);
      const exportedAt = deps.clock.now();
      await deps.audit.append(
        tx,
        auditEntryOf({
          actor,
          action: ACTION,
          resourceType: 'lead',
          resourceId: leadId,
          result: 'success',
          correlationId: command.correlationId,
          occurredAt: exportedAt,
          metadata: {
            submissions: data.submissions.length,
            consents: data.consents.length,
            activities: data.activities.length,
            truncated: data.truncated,
          },
        }),
      );
      return ok({ lead, data, exportedAt });
    });
}
