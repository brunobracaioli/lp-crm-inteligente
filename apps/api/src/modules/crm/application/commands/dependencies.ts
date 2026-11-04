import type { LeadActivityRepository, LeadRepository } from '#/modules/crm/application/ports.ts';
import type {
  LeadReader,
  StaffIdempotencyStore,
} from '#/modules/crm/application/commands/ports.ts';
import type { AuditLogWriter } from '#/shared/audit.ts';
import type { IdGenerator } from '#/shared/ids.ts';
import type { Clock } from '#/shared/time.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

/** What every lead mutation needs: one transaction, the aggregate store, the timeline and the audit trail. */
export interface MutationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly leads: LeadReader;
  /** Optimistic `update(tx, state, expectedVersion)` of the existing lead repository. */
  readonly leadWriter: Pick<LeadRepository, 'update'>;
  readonly activities: LeadActivityRepository;
  readonly audit: AuditLogWriter;
  readonly idempotency: StaffIdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
