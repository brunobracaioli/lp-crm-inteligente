import type { LeadStage, ScoreBand } from '#/modules/crm/domain/lead-types.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import { assertPageLimit } from '#/modules/crm/application/queries/pagination.ts';
import type {
  CursorCodec,
  CursorScope,
  KeysetPosition,
  LeadFilters,
  LeadQueries,
  LeadSummaryView,
  OwnerFilter,
} from '#/modules/crm/application/queries/ports.ts';
import type { SearchTerm } from '#/modules/crm/application/queries/search-term.ts';

/** `me` is resolved against the authenticated principal; a UUID is a workspace member's id. */
export type OwnerFilterInput = 'me' | 'unassigned' | UserId;

export interface LeadFilterInput {
  readonly stage: LeadStage | null;
  readonly owner: OwnerFilterInput | null;
  readonly scoreBand: ScoreBand | null;
}

export interface ListLeadsInput {
  /** From the authenticated principal, never from the request. */
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly filters: LeadFilterInput;
  /** Already validated by the route: 1–100. */
  readonly limit: number;
  /** `next_cursor` of the previous page. */
  readonly cursor: string | null;
}

export interface SearchLeadsInput extends ListLeadsInput {
  /** Null behaves exactly like the list. */
  readonly term: SearchTerm | null;
}

export interface LeadPage {
  readonly items: readonly LeadSummaryView[];
  readonly nextCursor: string | null;
}

export interface LeadPageFailure {
  readonly code: 'invalid_cursor';
}

export interface LeadPageDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly queries: LeadQueries;
  readonly cursors: CursorCodec;
}

export type ListLeads = (input: ListLeadsInput) => Promise<Result<LeadPage, LeadPageFailure>>;
export type SearchLeads = (input: SearchLeadsInput) => Promise<Result<LeadPage, LeadPageFailure>>;

function resolveOwner(owner: OwnerFilterInput | null, userId: UserId): OwnerFilter | null {
  if (owner === null) return null;
  if (owner === 'unassigned') return { kind: 'unassigned' };
  return { kind: 'user', userId: owner === 'me' ? userId : owner };
}

/**
 * The cursor is bound to the resolved filters (`me` already replaced by the user id) and to the
 * search term. The fingerprint only feeds the MAC; it never reaches the client, so the term (PII)
 * is not echoed in the opaque token.
 */
function fingerprint(filters: LeadFilters): string {
  const owner =
    filters.owner === null
      ? null
      : filters.owner.kind === 'unassigned'
        ? 'unassigned'
        : filters.owner.userId;
  return JSON.stringify([filters.stage, owner, filters.scoreBand, filters.prefix]);
}

async function pageLeads(
  deps: LeadPageDependencies,
  input: ListLeadsInput,
  term: SearchTerm | null,
): Promise<Result<LeadPage, LeadPageFailure>> {
  assertPageLimit(input.limit);
  const filters: LeadFilters = {
    stage: input.filters.stage,
    owner: resolveOwner(input.filters.owner, input.userId),
    scoreBand: input.filters.scoreBand,
    prefix: term,
  };
  const scope: CursorScope = {
    kind: 'leads',
    workspaceId: input.workspaceId,
    userId: input.userId,
    subject: fingerprint(filters),
  };

  let after: KeysetPosition | null = null;
  if (input.cursor !== null) {
    after = deps.cursors.decode(scope, input.cursor);
    if (after === null) return err({ code: 'invalid_cursor' });
  }

  const page = await deps.unitOfWork.run(input.workspaceId, (tx) =>
    deps.queries.listLeads(tx, {
      workspaceId: input.workspaceId,
      filters,
      limit: input.limit,
      after,
    }),
  );
  return ok({
    items: page.items,
    nextCursor: page.next === null ? null : deps.cursors.encode(scope, page.next),
  });
}

/** `GET /v1/crm/leads`: filters + signed keyset cursor, `ORDER BY created_at DESC, id ASC`. */
export function createListLeads(deps: LeadPageDependencies): ListLeads {
  return (input) => pageLeads(deps, input, null);
}

/** `POST /v1/crm/leads/search`: same page as the list, with the term in the body (no PII in URLs). */
export function createSearchLeads(deps: LeadPageDependencies): SearchLeads {
  return (input) => pageLeads(deps, input, input.term);
}
