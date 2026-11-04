import { auditEntryOf, NIL_UUID } from '#/modules/crm/application/commands/support.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import type { AuditLogWriter } from '#/shared/audit.ts';
import type { CorrelationId } from '#/shared/ids.ts';
import type { Clock } from '#/shared/time.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

export interface DenialRecord {
  readonly actor: StaffActor;
  /** The operation's `x-audit-action`. */
  readonly action: string;
  readonly resourceType: 'lead' | 'lead_export';
  /** The lead id from the path when it is a UUID; anything else is stored as the nil UUID. */
  readonly resourceId: string | null;
  /** Stable code of the refusal (`forbidden`, `mfa_required`, `reauthentication_required`). */
  readonly reason: string;
  readonly correlationId: CorrelationId;
}

/**
 * Records a refused attempt (role, MFA) in its own transaction — the request never reaches a
 * mutating transaction, so there is nothing to roll back with. Best effort by design: a failing
 * audit store must not turn a `403` into a different answer, so this resolves to `false` instead of
 * throwing and the caller logs the loss.
 */
export type RecordDenial = (record: DenialRecord) => Promise<boolean>;

export interface RecordDenialDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly audit: AuditLogWriter;
  readonly clock: Clock;
}

export function createRecordDenial(deps: RecordDenialDependencies): RecordDenial {
  return async (record) => {
    try {
      await deps.unitOfWork.run(record.actor.workspaceId, (tx) =>
        deps.audit.append(
          tx,
          auditEntryOf({
            actor: record.actor,
            action: record.action,
            resourceType: record.resourceType,
            resourceId: record.resourceId ?? NIL_UUID,
            result: 'denied',
            correlationId: record.correlationId,
            occurredAt: deps.clock.now(),
            metadata: { reason: record.reason },
          }),
        ),
      );
      return true;
    } catch {
      return false;
    }
  };
}
