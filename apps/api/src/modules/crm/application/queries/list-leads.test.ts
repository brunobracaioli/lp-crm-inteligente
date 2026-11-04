import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '#test/fakes/clock.ts';
import {
  InMemoryLeadQueries,
  OTHER_USER,
  USER_A,
  WORKSPACE_A,
  WORKSPACE_B,
  aCursorCodec,
  aFakeUnitOfWork,
  aProfile,
} from '#test/fakes/crm-read.ts';
import {
  createListLeads,
  createSearchLeads,
  type LeadFilterInput,
  type ListLeadsInput,
} from './list-leads.ts';
import { parseSearchTerm, type SearchTerm } from './search-term.ts';

const NO_FILTERS: LeadFilterInput = { stage: null, owner: null, scoreBand: null };
const T0 = new Date('2026-11-03T14:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const id = (n: number): string => `0194f1c2-aaaa-7000-8000-${n.toString().padStart(12, '0')}`;

let queries: InMemoryLeadQueries;
let clock: FakeClock;
let unitOfWork: ReturnType<typeof aFakeUnitOfWork>;

function build() {
  const deps = { unitOfWork, queries, cursors: aCursorCodec(clock) };
  return { list: createListLeads(deps), search: createSearchLeads(deps), cursors: deps.cursors };
}

function input(overrides: Partial<ListLeadsInput> = {}): ListLeadsInput {
  return {
    workspaceId: WORKSPACE_A,
    userId: USER_A,
    filters: NO_FILTERS,
    limit: 2,
    cursor: null,
    ...overrides,
  };
}

function term(raw: string): SearchTerm {
  const parsed = parseSearchTerm(raw);
  if (!parsed.ok) throw new Error('bad test term');
  return parsed.value;
}

beforeEach(() => {
  clock = new FakeClock();
  unitOfWork = aFakeUnitOfWork();
  queries = new InMemoryLeadQueries();
  for (let n = 1; n <= 5; n += 1) {
    queries.addLead(WORKSPACE_A, aProfile(id(n), at(-n * 10)));
  }
  queries.addLead(WORKSPACE_B, aProfile(id(99), at(100), { firstName: 'Intruder' }));
});

describe('listLeads', () => {
  it('pages through the whole list with signed cursors, without gaps or duplicates', async () => {
    const { list } = build();
    const seen: string[] = [];

    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const result = await list(input({ cursor }));
      if (!result.ok) throw new Error('unexpected failure');
      seen.push(...result.value.items.map((item) => item.id));
      cursor = result.value.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  });

  it('runs inside the principal workspace and never returns another workspace', async () => {
    const { list } = build();

    const result = await list(input({ limit: 100 }));

    expect(unitOfWork.scopes).toEqual([WORKSPACE_A]);
    expect(queries.calls.every((call) => call.workspaceId === WORKSPACE_A)).toBe(true);
    expect(result.ok && result.value.items.some((item) => item.firstName === 'Intruder')).toBe(
      false,
    );
  });

  it('ends with a null cursor when the page is not full', async () => {
    const { list } = build();

    const result = await list(input({ limit: 5 }));

    expect(result).toMatchObject({ ok: true, value: { nextCursor: null } });
  });

  it('resolves owner=me to the principal and unassigned to leads without owner', async () => {
    const mine = aProfile(id(10), at(50), { ownerUserId: USER_A });
    queries.addLead(WORKSPACE_A, mine);
    queries.addLead(WORKSPACE_A, aProfile(id(11), at(51), { ownerUserId: OTHER_USER }));
    const { list } = build();

    const me = await list(input({ limit: 100, filters: { ...NO_FILTERS, owner: 'me' } }));
    const unassigned = await list(
      input({ limit: 100, filters: { ...NO_FILTERS, owner: 'unassigned' } }),
    );
    const other = await list(input({ limit: 100, filters: { ...NO_FILTERS, owner: OTHER_USER } }));

    expect(me.ok && me.value.items.map((item) => item.id)).toEqual([id(10)]);
    expect(unassigned.ok && unassigned.value.items).toHaveLength(5);
    expect(other.ok && other.value.items.map((item) => item.id)).toEqual([id(11)]);
  });

  it('filters by stage and score band', async () => {
    queries.addLead(WORKSPACE_A, aProfile(id(20), at(60), { stage: 'won', scoreBand: 'C' }));
    const { list } = build();

    const result = await list(
      input({ limit: 100, filters: { ...NO_FILTERS, stage: 'won', scoreBand: 'C' } }),
    );

    expect(result.ok && result.value.items.map((item) => item.id)).toEqual([id(20)]);
  });

  describe('cursor binding', () => {
    async function firstCursor(overrides: Partial<ListLeadsInput> = {}): Promise<string> {
      const { list } = build();
      const result = await list(input(overrides));
      if (!result.ok || result.value.nextCursor === null) throw new Error('expected a next page');
      return result.value.nextCursor;
    }

    it('rejects a cursor used with different filters', async () => {
      const cursor = await firstCursor();
      const { list } = build();

      const result = await list(input({ cursor, filters: { ...NO_FILTERS, scoreBand: 'A' } }));

      expect(result).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
    });

    it('rejects a cursor used by another user', async () => {
      const cursor = await firstCursor();
      const { list } = build();

      const result = await list(input({ cursor, userId: OTHER_USER }));

      expect(result).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
    });

    it('rejects a cursor of one workspace used in another', async () => {
      const cursor = await firstCursor();
      const { list } = build();

      const result = await list(input({ cursor, workspaceId: WORKSPACE_B }));

      expect(result).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
    });

    it('rejects a tampered cursor and an expired one', async () => {
      const cursor = await firstCursor();
      const { list } = build();
      const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;

      const forged = await list(input({ cursor: tampered }));
      clock.advance(2 * 60 * 60 * 1000);
      const expired = await list(input({ cursor }));

      expect(forged).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
      expect(expired).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
    });

    it('does not load anything for an invalid cursor', async () => {
      const { list } = build();

      await list(input({ cursor: 'garbage.cursor' }));

      expect(queries.calls).toHaveLength(0);
    });

    it('treats me and the explicit own id as the same filter (same fingerprint)', async () => {
      for (let n = 40; n < 43; n += 1) {
        queries.addLead(WORKSPACE_A, aProfile(id(n), at(n), { ownerUserId: USER_A }));
      }
      const cursor = await firstCursor({ filters: { ...NO_FILTERS, owner: 'me' } });
      const { list } = build();

      const result = await list(input({ cursor, filters: { ...NO_FILTERS, owner: USER_A } }));

      expect(result.ok).toBe(true);
    });
  });

  it.each([0, 101, 1.5, Number.NaN])('refuses the programming error limit=%s', async (limit) => {
    const { list } = build();

    await expect(list(input({ limit }))).rejects.toThrow(RangeError);
  });
});

describe('searchLeads', () => {
  it('matches a prefix of name, surname, full name, company or e-mail, case-insensitively', async () => {
    queries.addLead(
      WORKSPACE_A,
      aProfile(id(30), at(70), {
        firstName: 'Joana',
        lastName: 'Duarte',
        companyName: 'Zeta Tech',
        email: 'jd@zeta.io',
      }),
    );
    const { search } = build();
    const idsFor = async (raw: string): Promise<string[]> => {
      const result = await search({ ...input({ limit: 100 }), term: term(raw) });
      return result.ok ? result.value.items.map((item) => item.id) : [];
    };

    expect(await idsFor('joa')).toEqual([id(30)]);
    expect(await idsFor('DUAR')).toEqual([id(30)]);
    expect(await idsFor('joana dua')).toEqual([id(30)]);
    expect(await idsFor('zeta')).toEqual([id(30)]);
    expect(await idsFor('JD@')).toEqual([id(30)]);
    expect(await idsFor('eta')).toEqual([]);
  });

  it('behaves like the list when there is no term', async () => {
    const { list, search } = build();

    const listed = await list(input({ limit: 100 }));
    const searched = await search({ ...input({ limit: 100 }), term: null });

    expect(searched).toEqual(listed);
  });

  it('binds the cursor to the term: it cannot be replayed with another term or as the list', async () => {
    const { search, list } = build();
    const first = await search({ ...input(), term: term('ca') });
    if (!first.ok || first.value.nextCursor === null) throw new Error('expected a next page');
    const cursor = first.value.nextCursor;

    const sameTerm = await search({ ...input({ cursor }), term: term('ca') });
    const otherTerm = await search({ ...input({ cursor }), term: term('ma') });
    const asList = await list(input({ cursor }));

    expect(sameTerm.ok).toBe(true);
    expect(otherTerm).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
    expect(asList).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
  });
});
