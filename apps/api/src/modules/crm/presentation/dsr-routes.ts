import { Hono } from 'hono';
import {
  assertRecentMfa,
  assertRole,
  MAX_MFA_AGE_SECONDS,
  type StaffEnv,
  type StaffGuards,
} from '#/platform/auth/staff.ts';
import type {
  AnonymizeLead,
  AnonymizeOutcome,
} from '#/modules/crm/application/commands/anonymize-lead.ts';
import type { ExportLeadData } from '#/modules/crm/application/commands/export-lead-data.ts';
import type { ExportLeadsCsv } from '#/modules/crm/application/commands/export-leads-csv.ts';
import { bodyRequestsConfirmation } from '#/modules/crm/application/commands/inputs.ts';
import type { RecordDenial } from '#/modules/crm/application/commands/record-denial.ts';
import { leadDataExportView } from '#/modules/crm/presentation/data-export-view.ts';
import {
  auditableLeadId,
  enforceWithAudit,
  failureToProblem,
  parseLeadId,
  readIdempotencyKey,
  readRawBody,
  staffActorOf,
} from '#/modules/crm/presentation/staff-http.ts';
import type { Clock } from '#/shared/time.ts';

export interface CrmDsrRoutesDependencies {
  readonly guards: StaffGuards;
  readonly exportLeadsCsv: ExportLeadsCsv;
  readonly exportLeadData: ExportLeadData;
  readonly anonymizeLead: AnonymizeLead;
  /** Best-effort audit of role/MFA denials (`createRecordDenial`). */
  readonly recordDenial: RecordDenial;
  /** The clock the MFA age is measured against (injectable: no sleeping in tests). */
  readonly clock: Clock;
}

const HTTP_OK = 200;
/** `data-export` requires AAL2 but, unlike export and anonymize, no maximum MFA age (contract). */
const AAL2_WITHOUT_AGE_LIMIT = Number.POSITIVE_INFINITY;
const PRIVILEGED_ROLES = ['owner', 'admin'] as const;

function anonymizeView(outcome: AnonymizeOutcome): Record<string, unknown> {
  if (outcome.mode === 'applied') {
    return {
      mode: 'applied',
      lead_id: outcome.leadId,
      anonymized_at: outcome.anonymizedAt.toISOString(),
      version: outcome.version,
    };
  }
  return {
    mode: 'preview',
    lead_id: outcome.leadId,
    lead_version: outcome.leadVersion,
    plan_hash: outcome.planHash,
    expires_at: outcome.expiresAt.toISOString(),
    will_erase: outcome.willErase.map((item) => ({ category: item.category, count: item.count })),
    will_keep: [...outcome.willKeep],
  };
}

/**
 * `GET /v1/crm/leads/export.csv`, `GET …/{id}/data-export`, `POST …/{id}/anonymize` (contract,
 * crm-privacy): the sensitive-data routes. Guards run inside the handlers, in the contract's order,
 * so every refusal (role, AAL2, MFA age) is audited as `denied` before it is returned.
 *
 * Mount order: register these routes BEFORE any `GET /v1/crm/leads/:id` route, or `export.csv`
 * would be read as a lead id.
 */
export function createCrmDsrRoutes(deps: CrmDsrRoutesDependencies): Hono<StaffEnv> {
  const routes = new Hono<StaffEnv>();
  const { guards } = deps;

  routes.get(
    '/v1/crm/leads/export.csv',
    guards.authenticate,
    guards.rateLimit('export', 'closed'),
    async (c) => {
      await enforceWithAudit(
        c,
        {
          recordDenial: deps.recordDenial,
          action: 'lead.exported',
          resourceType: 'lead_export',
          resourceId: null,
        },
        (principal) => {
          assertRole(principal, PRIVILEGED_ROLES);
          assertRecentMfa(principal, deps.clock.now(), MAX_MFA_AGE_SECONDS);
        },
      );
      const result = await deps.exportLeadsCsv({
        actor: staffActorOf(c.get('staff')),
        query: new Map(Object.entries(c.req.queries())),
        correlationId: c.get('correlationId'),
      });
      if (!result.ok) {
        throw failureToProblem(result.error);
      }
      const { csv, rowCount, truncated, fileDate } = result.value;
      return c.body(csv, HTTP_OK, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="leads-${fileDate}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Export-Row-Count': String(rowCount),
        'X-Export-Truncated': truncated ? 'true' : 'false',
      });
    },
  );

  routes.get(
    '/v1/crm/leads/:id/data-export',
    guards.authenticate,
    guards.rateLimit('read', 'closed'),
    async (c) => {
      const rawId = c.req.param('id');
      await enforceWithAudit(
        c,
        {
          recordDenial: deps.recordDenial,
          action: 'lead.data_exported',
          resourceType: 'lead',
          resourceId: auditableLeadId(rawId),
        },
        (principal) => {
          assertRole(principal, PRIVILEGED_ROLES);
          assertRecentMfa(principal, deps.clock.now(), AAL2_WITHOUT_AGE_LIMIT);
        },
      );
      const leadId = parseLeadId(rawId);
      const result = await deps.exportLeadData({
        actor: staffActorOf(c.get('staff')),
        leadId,
        correlationId: c.get('correlationId'),
      });
      if (!result.ok) {
        throw failureToProblem(result.error);
      }
      return c.json(leadDataExportView(result.value), HTTP_OK, {
        'Content-Disposition': `attachment; filename="lead-data-export-${leadId}.json"`,
        'Cache-Control': 'no-store',
      });
    },
  );

  routes.post(
    '/v1/crm/leads/:id/anonymize',
    guards.authenticate,
    guards.rateLimit('write', 'closed'),
    async (c) => {
      const rawId = c.req.param('id');
      // Read first: whether the body confirms decides the audit action and the MFA age rule. Reading
      // decides nothing else — an unreadable body is reported by the use case after the lead checks.
      const body = await readRawBody(c);
      const confirming = bodyRequestsConfirmation(body);
      await enforceWithAudit(
        c,
        {
          recordDenial: deps.recordDenial,
          action: confirming ? 'lead.anonymized' : 'lead.anonymize_previewed',
          resourceType: 'lead',
          resourceId: auditableLeadId(rawId),
        },
        (principal) => {
          assertRole(principal, PRIVILEGED_ROLES);
          // AAL2 always; the 300 s freshness only guards the destructive step (confirm = true).
          assertRecentMfa(
            principal,
            deps.clock.now(),
            confirming ? MAX_MFA_AGE_SECONDS : AAL2_WITHOUT_AGE_LIMIT,
          );
        },
      );
      const leadId = parseLeadId(rawId);
      const result = await deps.anonymizeLead({
        actor: staffActorOf(c.get('staff')),
        leadId,
        body,
        idempotencyKey: readIdempotencyKey(c),
        correlationId: c.get('correlationId'),
      });
      if (!result.ok) {
        throw failureToProblem(result.error);
      }
      return c.json(anonymizeView(result.value), HTTP_OK);
    },
  );

  return routes;
}
