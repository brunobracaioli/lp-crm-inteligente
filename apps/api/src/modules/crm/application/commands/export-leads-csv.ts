import { fail, type CommandResult } from '#/modules/crm/application/commands/failures.ts';
import { parseExportQuery, type RawQuery } from '#/modules/crm/application/commands/inputs.ts';
import type {
  ExportLock,
  LeadExportFilter,
  LeadExportReader,
  LeadExportRow,
  StaffActor,
} from '#/modules/crm/application/commands/ports.ts';
import { auditEntryOf } from '#/modules/crm/application/commands/support.ts';
import { encodeCsv, type CsvCell } from '#/modules/crm/domain/csv-export.ts';
import type { AuditLogWriter } from '#/shared/audit.ts';
import type { CorrelationId, IdGenerator } from '#/shared/ids.ts';
import { ok } from '#/shared/result.ts';
import type { Clock } from '#/shared/time.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';

/** Hard ceiling of one export (contract; threat model C29). One extra row detects truncation. */
export const EXPORT_MAX_ROWS = 10_000;

/** `Retry-After` suggested to a user whose previous export is still running. */
export const EXPORT_IN_PROGRESS_RETRY_AFTER_SECONDS = 10;

export const EXPORT_COLUMNS = [
  'lead_id',
  'created_at',
  'first_name',
  'last_name',
  'email',
  'whatsapp',
  'company_name',
  'area_of_expertise',
  'area_of_expertise_other',
  'job_title',
  'company_size',
  'company_website',
  'stage',
  'lost_reason',
  'score',
  'score_band',
  'owner_user_id',
  'marketing_opt_in',
  'submissions_count',
  'first_submitted_at',
  'last_submitted_at',
  'anonymized_at',
  'first_touch_utm_source',
  'first_touch_utm_medium',
  'first_touch_utm_campaign',
  'last_touch_utm_source',
  'last_touch_utm_medium',
  'last_touch_utm_campaign',
] as const;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export function csvCellsOf(row: LeadExportRow): readonly CsvCell[] {
  return [
    row.leadId,
    iso(row.createdAt),
    row.firstName,
    row.lastName,
    row.email,
    row.whatsapp,
    row.companyName,
    row.areaOfExpertise,
    row.areaOfExpertiseOther,
    row.jobTitle,
    row.companySize,
    row.companyWebsite,
    row.stage,
    row.lostReason,
    row.score,
    row.scoreBand,
    row.ownerUserId,
    row.marketingOptIn,
    row.submissionsCount,
    iso(row.firstSubmittedAt),
    iso(row.lastSubmittedAt),
    iso(row.anonymizedAt),
    row.firstTouchUtmSource,
    row.firstTouchUtmMedium,
    row.firstTouchUtmCampaign,
    row.lastTouchUtmSource,
    row.lastTouchUtmMedium,
    row.lastTouchUtmCampaign,
  ];
}

export interface LeadsCsvExport {
  readonly csv: string;
  readonly rowCount: number;
  readonly truncated: boolean;
  /** `YYYYMMDD` (UTC) for the server-generated file name. */
  readonly fileDate: string;
}

export interface ExportLeadsCsvDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: LeadExportReader;
  readonly lock: ExportLock;
  readonly audit: AuditLogWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface ExportLeadsCsvCommand {
  readonly actor: StaffActor;
  readonly query: RawQuery;
  readonly correlationId: CorrelationId;
}

export type ExportLeadsCsv = (
  command: ExportLeadsCsvCommand,
) => Promise<CommandResult<LeadsCsvExport>>;

const ACTION = 'lead.exported';

function filterKeys(filter: LeadExportFilter): string {
  return Object.entries(filter)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort()
    .join(',');
}

function fileDateOf(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * `GET /v1/crm/leads/export.csv` (crm §7, contract `exportLeadsCsv`): query → one-export-per-user
 * lock → read ≤ 10 000 rows → CSV with formula neutralization → audit, all in one transaction so an
 * export that cannot be recorded is never delivered. The audit row carries the row count and the
 * NAMES of the filters applied, never their values. The lock is released whatever happens.
 */
export function createExportLeadsCsv(deps: ExportLeadsCsvDependencies): ExportLeadsCsv {
  return async (command) => {
    const { actor } = command;
    if (actor.role !== 'owner' && actor.role !== 'admin') {
      return fail({ code: 'forbidden' });
    }
    const query = parseExportQuery(command.query);
    if (!query.ok) {
      return query;
    }
    const filter: LeadExportFilter = {
      ...(query.value.stage === undefined ? {} : { stage: query.value.stage }),
      ...(query.value.scoreBand === undefined ? {} : { scoreBand: query.value.scoreBand }),
      ...(query.value.owner === undefined
        ? {}
        : {
            owner:
              query.value.owner === 'unassigned'
                ? ({ kind: 'unassigned' } as const)
                : ({
                    kind: 'user',
                    userId: query.value.owner === 'me' ? actor.userId : query.value.owner,
                  } as const),
          }),
    };

    const lease = await deps.lock.acquire(actor.workspaceId, actor.userId);
    if (lease === null) {
      return fail({
        code: 'export_in_progress',
        retryAfterSeconds: EXPORT_IN_PROGRESS_RETRY_AFTER_SECONDS,
      });
    }
    try {
      const exported = await deps.unitOfWork.run(actor.workspaceId, async (tx) => {
        const rows = await deps.reader.read(tx, actor.workspaceId, filter, EXPORT_MAX_ROWS + 1);
        const truncated = rows.length > EXPORT_MAX_ROWS;
        const kept = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;
        const now = deps.clock.now();
        const csv = encodeCsv(EXPORT_COLUMNS, kept.map(csvCellsOf));
        await deps.audit.append(
          tx,
          auditEntryOf({
            actor,
            action: ACTION,
            resourceType: 'lead_export',
            resourceId: deps.ids.uuidv7(),
            result: 'success',
            correlationId: command.correlationId,
            occurredAt: now,
            metadata: { row_count: kept.length, truncated, filters: filterKeys(filter) },
          }),
        );
        return { csv, rowCount: kept.length, truncated, fileDate: fileDateOf(now) };
      });
      return ok(exported);
    } finally {
      await lease.release();
    }
  };
}
