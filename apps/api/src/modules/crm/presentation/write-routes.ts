import { Hono } from 'hono';
import { assertRole, type StaffEnv, type StaffGuards } from '#/platform/auth/staff.ts';
import type { AddLeadNote } from '#/modules/crm/application/commands/add-lead-note.ts';
import type { AssignLeadOwner } from '#/modules/crm/application/commands/assign-lead-owner.ts';
import type { ChangeLeadStage } from '#/modules/crm/application/commands/change-lead-stage.ts';
import type { RecordDenial } from '#/modules/crm/application/commands/record-denial.ts';
import {
  auditableLeadId,
  enforceWithAudit,
  failureToProblem,
  parseLeadId,
  readIdempotencyKey,
  readRawBody,
  staffActorOf,
} from '#/modules/crm/presentation/staff-http.ts';
import { leadSummaryView, noteActivityView } from '#/modules/crm/presentation/mutation-views.ts';

export interface CrmWriteRoutesDependencies {
  readonly guards: StaffGuards;
  readonly changeLeadStage: ChangeLeadStage;
  readonly assignLeadOwner: AssignLeadOwner;
  readonly addLeadNote: AddLeadNote;
  /** Best-effort audit of role denials (`createRecordDenial`). */
  readonly recordDenial: RecordDenial;
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;

/**
 * `PATCH /v1/crm/leads/{id}/stage`, `PATCH …/owner`, `POST …/notes` (contract, crm-leads). Thin by
 * design, in the contract's order: authenticate → rate limit → role (denials audited) → id (400) →
 * use case (load → per-resource rule → body → business rules). Every route is deny-by-default
 * behind `guards.authenticate`; the workspace and the role come from the principal, never from the
 * request.
 */
export function createCrmWriteRoutes(deps: CrmWriteRoutesDependencies): Hono<StaffEnv> {
  const routes = new Hono<StaffEnv>();
  const { guards } = deps;

  routes.patch(
    '/v1/crm/leads/:id/stage',
    guards.authenticate,
    guards.rateLimit('write', 'open'),
    async (c) => {
      const rawId = c.req.param('id');
      await enforceWithAudit(
        c,
        {
          recordDenial: deps.recordDenial,
          action: 'lead.stage_changed',
          resourceType: 'lead',
          resourceId: auditableLeadId(rawId),
        },
        (principal) => {
          assertRole(principal, ['owner', 'admin', 'sales']);
        },
      );
      const leadId = parseLeadId(rawId);
      const idempotencyKey = readIdempotencyKey(c);
      const body = await readRawBody(c);
      const result = await deps.changeLeadStage({
        actor: staffActorOf(c.get('staff')),
        leadId,
        body,
        idempotencyKey,
        correlationId: c.get('correlationId'),
      });
      if (!result.ok) {
        throw failureToProblem(result.error);
      }
      return c.json(leadSummaryView(result.value), HTTP_OK);
    },
  );

  routes.patch(
    '/v1/crm/leads/:id/owner',
    guards.authenticate,
    guards.rateLimit('write', 'open'),
    async (c) => {
      const rawId = c.req.param('id');
      await enforceWithAudit(
        c,
        {
          recordDenial: deps.recordDenial,
          action: 'lead.owner_assigned',
          resourceType: 'lead',
          resourceId: auditableLeadId(rawId),
        },
        (principal) => {
          assertRole(principal, ['owner', 'admin']);
        },
      );
      const leadId = parseLeadId(rawId);
      const idempotencyKey = readIdempotencyKey(c);
      const body = await readRawBody(c);
      const result = await deps.assignLeadOwner({
        actor: staffActorOf(c.get('staff')),
        leadId,
        body,
        idempotencyKey,
        correlationId: c.get('correlationId'),
      });
      if (!result.ok) {
        throw failureToProblem(result.error);
      }
      return c.json(leadSummaryView(result.value), HTTP_OK);
    },
  );

  routes.post(
    '/v1/crm/leads/:id/notes',
    guards.authenticate,
    guards.rateLimit('write', 'open'),
    async (c) => {
      const rawId = c.req.param('id');
      await enforceWithAudit(
        c,
        {
          recordDenial: deps.recordDenial,
          action: 'lead.note_added',
          resourceType: 'lead',
          resourceId: auditableLeadId(rawId),
        },
        (principal) => {
          assertRole(principal, ['owner', 'admin', 'sales']);
        },
      );
      const leadId = parseLeadId(rawId);
      const idempotencyKey = readIdempotencyKey(c);
      const body = await readRawBody(c);
      const result = await deps.addLeadNote({
        actor: staffActorOf(c.get('staff')),
        leadId,
        body,
        idempotencyKey,
        correlationId: c.get('correlationId'),
      });
      if (!result.ok) {
        throw failureToProblem(result.error);
      }
      return c.json(noteActivityView(result.value), HTTP_CREATED);
    },
  );

  return routes;
}
