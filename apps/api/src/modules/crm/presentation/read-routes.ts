import { Hono, type Context } from 'hono';
import { HttpProblem } from '#/platform/errors/problem.ts';
import {
  requireRole,
  STAFF_ROLES,
  type StaffEnv,
  type StaffGuards,
} from '#/platform/auth/staff.ts';
import type { GetLeadDetail } from '#/modules/crm/application/queries/get-lead-detail.ts';
import type {
  LeadFilterInput,
  ListLeads,
  SearchLeads,
} from '#/modules/crm/application/queries/list-leads.ts';
import {
  DEFAULT_ACTIVITIES_PAGE_SIZE,
  DEFAULT_LEAD_PAGE_SIZE,
} from '#/modules/crm/application/queries/pagination.ts';
import { parseSearchTerm, type SearchTerm } from '#/modules/crm/application/queries/search-term.ts';
import type { LeadId } from '#/shared/ids.ts';
import { leadDetailJson, leadPageJson } from '#/modules/crm/presentation/lead-views.ts';
import {
  leadDetailQuerySchema,
  leadIdSchema,
  leadListQuerySchema,
  leadSearchBodySchema,
  parseOrThrow,
  readQueryParameters,
  validationProblem,
} from '#/modules/crm/presentation/read-validation.ts';

/** Contract `x-roles` of the three read operations: every workspace role may read. */
export const CRM_READ_ROLES = STAFF_ROLES;

export interface CrmReadRoutesDependencies {
  readonly guards: StaffGuards;
  readonly listLeads: ListLeads;
  readonly searchLeads: SearchLeads;
  readonly getLeadDetail: GetLeadDetail;
}

const JSON_MEDIA_TYPE = 'application/json';
const UTF8_CHARSET_PARAMETERS: ReadonlySet<string> = new Set(['charset=utf-8', 'charset="utf-8"']);

/** `Content-Type` must be `application/json`, optionally with `charset=utf-8`. */
function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [mediaType, ...parameters] = header.split(';').map((part) => part.trim().toLowerCase());
  return mediaType === JSON_MEDIA_TYPE && parameters.every((p) => UTF8_CHARSET_PARAMETERS.has(p));
}

/** Malformed JSON is `400 invalid_json`; the parser message (which could echo input) is dropped. */
async function readJsonBody(c: Context<StaffEnv>): Promise<unknown> {
  if (!isJsonContentType(c.req.header('Content-Type'))) {
    throw new HttpProblem(415, 'unsupported_media_type');
  }
  try {
    return JSON.parse(await c.req.text()) as unknown;
  } catch {
    throw new HttpProblem(400, 'invalid_json');
  }
}

function cursorProblem(field: string): HttpProblem {
  return validationProblem([{ field, code: 'invalid_format' }]);
}

interface FilterFields {
  readonly stage?: LeadFilterInput['stage'] | undefined;
  readonly owner?: string | undefined;
  readonly score_band?: LeadFilterInput['scoreBand'] | undefined;
}

function toFilters(fields: FilterFields): LeadFilterInput {
  return {
    stage: fields.stage ?? null,
    // The schema admits only `me`, `unassigned` or a lowercase UUID.
    owner: (fields.owner ?? null) as LeadFilterInput['owner'],
    scoreBand: fields.score_band ?? null,
  };
}

/** One structured line: operation, outcome and row count only — no filters, term, cursor or lead data. */
function logRead(c: Context<StaffEnv>, operation: string, rows: number): void {
  c.get('logger').info({ module: 'crm', operation, outcome: 'ok', rows }, 'crm read handled');
}

/**
 * Presentation of the CRM read side: list, search and detail of leads. Every route runs, in order,
 * `authenticate` (401) → per-user read rate limit (fail-open, contract `x-rate-limit`) → role
 * allowlist (403) → validation of path/query/body (400/415) → use case → response. The workspace
 * and user come from the verified principal; no request value can select a tenant.
 */
export function createCrmReadRoutes(deps: CrmReadRoutesDependencies): Hono<StaffEnv> {
  const routes = new Hono<StaffEnv>();
  const { authenticate } = deps.guards;
  const rateLimit = deps.guards.rateLimit('read', 'open');
  const allowRead = requireRole(...CRM_READ_ROLES);

  routes.get('/v1/crm/leads', authenticate, rateLimit, allowRead, async (c) => {
    const staff = c.get('staff');
    const query = parseOrThrow(leadListQuerySchema, readQueryParameters(c.req.url));

    const result = await deps.listLeads({
      workspaceId: staff.workspaceId,
      userId: staff.userId,
      filters: toFilters(query),
      limit: query.limit ?? DEFAULT_LEAD_PAGE_SIZE,
      cursor: query.cursor ?? null,
    });
    if (!result.ok) throw cursorProblem('cursor');

    logRead(c, 'list_leads', result.value.items.length);
    return c.json(leadPageJson(result.value), 200);
  });

  routes.post('/v1/crm/leads/search', authenticate, rateLimit, allowRead, async (c) => {
    const staff = c.get('staff');
    const body = parseOrThrow(leadSearchBodySchema, await readJsonBody(c));
    let term: SearchTerm | null = null;
    if (body.q !== undefined) {
      const parsed = parseSearchTerm(body.q);
      if (!parsed.ok) throw validationProblem([{ field: 'q', code: parsed.error }]);
      term = parsed.value;
    }

    const result = await deps.searchLeads({
      workspaceId: staff.workspaceId,
      userId: staff.userId,
      filters: toFilters(body),
      term,
      limit: body.limit ?? DEFAULT_LEAD_PAGE_SIZE,
      cursor: body.cursor ?? null,
    });
    if (!result.ok) throw cursorProblem('cursor');

    logRead(c, 'search_leads', result.value.items.length);
    return c.json(leadPageJson(result.value), 200);
  });

  // `[^.]+` keeps literal siblings such as `/v1/crm/leads/export.csv` out of this route, whatever
  // the order in which the route groups are mounted.
  routes.get('/v1/crm/leads/:id{[^.]+}', authenticate, rateLimit, allowRead, async (c) => {
    const staff = c.get('staff');
    const id = leadIdSchema.safeParse(c.req.param('id'));
    if (!id.success) throw validationProblem([{ field: 'id', code: 'invalid_format' }]);
    const query = parseOrThrow(leadDetailQuerySchema, readQueryParameters(c.req.url));

    const result = await deps.getLeadDetail({
      workspaceId: staff.workspaceId,
      userId: staff.userId,
      leadId: id.data.toLowerCase() as LeadId,
      activitiesLimit: query.activities_limit ?? DEFAULT_ACTIVITIES_PAGE_SIZE,
      activitiesCursor: query.activities_cursor ?? null,
    });
    if (!result.ok) {
      if (result.error.code === 'not_found') throw new HttpProblem(404, 'not_found');
      throw cursorProblem('activities_cursor');
    }

    logRead(c, 'get_lead_detail', result.value.activities.items.length);
    return c.json(leadDetailJson(result.value), 200);
  });

  return routes;
}
