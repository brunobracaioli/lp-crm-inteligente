import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import { createGetLeadDetail } from '#/modules/crm/application/queries/get-lead-detail.ts';
import {
  createListLeads,
  createSearchLeads,
  type LeadFilterInput,
  type LeadPage,
} from '#/modules/crm/application/queries/list-leads.ts';
import { parseSearchTerm, type SearchTerm } from '#/modules/crm/application/queries/search-term.ts';
import { createPostgresLeadQueries } from '#/modules/crm/infrastructure/postgres-lead-queries.ts';
import { leadDetailJson } from '#/modules/crm/presentation/lead-views.ts';
import {
  aPrincipal,
  buildReadAppOn,
  detailPath,
  LIST_PATH,
  SEARCH_PATH,
} from '#test/crm/read-app.ts';
import { createContract } from '#test/contract/openapi.ts';
import { FakeClock } from '#test/fakes/clock.ts';
import { aCursorCodec } from '#test/fakes/crm-read.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import {
  DEFAULT_CREATED_AT,
  insertActivity,
  insertConsent,
  insertLead,
  insertSubmission,
  microsecondsAfter,
  type LeadSeed,
  type SeededLead,
} from './support/crm-read-fixtures.ts';
import { FixtureScope, type WorkspaceFixture } from './support/fixtures.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

const ids = new RandomUuidV7Generator();
const NO_FILTERS: LeadFilterInput = { stage: null, owner: null, scoreBand: null };
const contract = createContract();

let db: TestDatabase;
let scope: FixtureScope;
let uow: UnitOfWork;
let clock: FakeClock;

function useCases() {
  const deps = {
    unitOfWork: uow,
    queries: createPostgresLeadQueries(),
    cursors: aCursorCodec(clock),
  };
  return {
    queries: deps.queries,
    list: createListLeads(deps),
    search: createSearchLeads(deps),
    detail: createGetLeadDetail(deps),
  };
}

beforeAll(async () => {
  db = await openTestDatabase();
  uow = createPostgresUnitOfWork(db.app);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  scope = new FixtureScope(db.admin, ids);
  clock = new FakeClock();
});

afterEach(async () => {
  await scope.dispose();
});

/** Byte order like Postgres uuid/timestamp text (never locale-aware `localeCompare`). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const asUser = (id: string): UserId => id as UserId;

function term(raw: string): SearchTerm {
  const parsed = parseSearchTerm(raw);
  if (!parsed.ok) throw new Error(`bad test term ${raw}`);
  return parsed.value;
}

/** `created_at DESC, id ASC`, the contract ordering, computed in JS from the seeded values. */
function expectedOrder(leads: readonly SeededLead[]): string[] {
  return [...leads]
    .sort((a, b) =>
      a.createdAt === b.createdAt ? compareText(a.id, b.id) : compareText(b.createdAt, a.createdAt),
    )
    .map((lead) => lead.id);
}

async function collectAll(
  fetchPage: (cursor: string | null) => Promise<LeadPage>,
  maxPages = 50,
): Promise<{ readonly ids: string[]; readonly pages: number }> {
  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  while (pages < maxPages) {
    const page = await fetchPage(cursor);
    pages += 1;
    collected.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  return { ids: collected, pages };
}

async function listAll(
  workspaceId: WorkspaceId,
  limit: number,
  filters: LeadFilterInput = NO_FILTERS,
  userId = asUser('0194f1c2-1111-7000-8000-00000000000a'),
): Promise<string[]> {
  const { list } = useCases();
  const { ids: collected } = await collectAll(async (cursor) => {
    const result = await list({ workspaceId, userId, filters, limit, cursor });
    if (!result.ok) throw new Error('list failed');
    return result.value;
  });
  return collected;
}

describe('listLeads over Postgres: keyset pagination', () => {
  it('pages a list with equal and microsecond-apart created_at without gaps or duplicates', async () => {
    const { workspaceId } = await scope.workspace();
    const tie = '2026-11-03T14:00:00.123456Z';
    const seeds: LeadSeed[] = [
      { createdAt: tie },
      { createdAt: tie },
      { createdAt: tie },
      { createdAt: microsecondsAfter(tie, 1) },
      { createdAt: microsecondsAfter(tie, -1) },
      { createdAt: microsecondsAfter(tie, -1) },
      { createdAt: '2026-11-03T13:59:59.999999Z' },
      { createdAt: '2026-11-04T00:00:00.000000Z' },
    ];
    const seeded: SeededLead[] = [];
    for (const seed of seeds) seeded.push(await insertLead(db.admin, ids, workspaceId, seed));

    for (const limit of [1, 2, 3, 100]) {
      const collected = await listAll(workspaceId, limit);

      expect(collected, `limit ${String(limit)}`).toEqual(expectedOrder(seeded));
    }
  });

  it('reports the end of the list with a null cursor and an exact page count', async () => {
    const { workspaceId } = await scope.workspace();
    for (let n = 0; n < 5; n += 1) {
      await insertLead(db.admin, ids, workspaceId, {
        createdAt: microsecondsAfter(DEFAULT_CREATED_AT, n),
      });
    }
    const { list } = useCases();
    const userId = asUser('0194f1c2-1111-7000-8000-00000000000a');

    const result = await collectAll(async (cursor) => {
      const page = await list({ workspaceId, userId, filters: NO_FILTERS, limit: 5, cursor });
      if (!page.ok) throw new Error('list failed');
      return page.value;
    });

    expect(result.ids).toHaveLength(5);
    expect(result.pages).toBe(1);
  });

  it('does not skip or repeat rows when a newer lead arrives between two pages', async () => {
    const { workspaceId } = await scope.workspace();
    const seeded: SeededLead[] = [];
    for (let n = 0; n < 6; n += 1) {
      seeded.push(
        await insertLead(db.admin, ids, workspaceId, {
          createdAt: microsecondsAfter(DEFAULT_CREATED_AT, -n),
        }),
      );
    }
    const { list } = useCases();
    const userId = asUser('0194f1c2-1111-7000-8000-00000000000a');
    const first = await list({ workspaceId, userId, filters: NO_FILTERS, limit: 3, cursor: null });
    if (!first.ok) throw new Error('list failed');

    await insertLead(db.admin, ids, workspaceId, {
      createdAt: microsecondsAfter(DEFAULT_CREATED_AT, 500),
    });
    const second = await list({
      workspaceId,
      userId,
      filters: NO_FILTERS,
      limit: 3,
      cursor: first.value.nextCursor,
    });
    if (!second.ok) throw new Error('list failed');

    expect([...first.value.items, ...second.value.items].map((i) => i.id)).toEqual(
      expectedOrder(seeded),
    );
    expect(second.value.nextCursor).toBeNull();
  });
});

describe('listLeads over Postgres: filters', () => {
  it('filters by stage, score band and owner (me, unassigned, member) and combines them', async () => {
    const { workspaceId } = await scope.workspace();
    const me = '0194f1c2-1111-7000-8000-00000000000a';
    const other = '0194f1c2-1111-7000-8000-00000000000c';
    const t = (n: number): string => microsecondsAfter(DEFAULT_CREATED_AT, n);
    const wonMine = await insertLead(db.admin, ids, workspaceId, {
      createdAt: t(1),
      stage: 'won',
      scoreBand: 'A',
      ownerUserId: me,
    });
    const lostMine = await insertLead(db.admin, ids, workspaceId, {
      createdAt: t(2),
      stage: 'lost',
      scoreBand: 'C',
      ownerUserId: me,
    });
    const newOther = await insertLead(db.admin, ids, workspaceId, {
      createdAt: t(3),
      stage: 'new',
      scoreBand: 'A',
      ownerUserId: other,
    });
    const newFree = await insertLead(db.admin, ids, workspaceId, {
      createdAt: t(4),
      stage: 'new',
      scoreBand: 'B',
    });

    const idsFor = (filters: Partial<LeadFilterInput>): Promise<string[]> =>
      listAll(workspaceId, 2, { ...NO_FILTERS, ...filters }, asUser(me));

    expect(await idsFor({ stage: 'new' })).toEqual([newFree.id, newOther.id]);
    expect(await idsFor({ scoreBand: 'A' })).toEqual([newOther.id, wonMine.id]);
    expect(await idsFor({ owner: 'me' })).toEqual([lostMine.id, wonMine.id]);
    expect(await idsFor({ owner: 'unassigned' })).toEqual([newFree.id]);
    expect(await idsFor({ owner: asUser(other) })).toEqual([newOther.id]);
    expect(await idsFor({ stage: 'won', owner: 'me', scoreBand: 'A' })).toEqual([wonMine.id]);
    expect(await idsFor({ stage: 'won', owner: 'unassigned' })).toEqual([]);
  });
});

describe('searchLeads over Postgres', () => {
  async function seedPeople(workspaceId: WorkspaceId) {
    const t = (n: number): string => microsecondsAfter(DEFAULT_CREATED_AT, n);
    return {
      carla: await insertLead(db.admin, ids, workspaceId, {
        createdAt: t(1),
        firstName: 'Carla',
        lastName: 'Menezes',
        companyName: 'Acme Ltda',
        email: 'carla@acme.com.br',
      }),
      joana: await insertLead(db.admin, ids, workspaceId, {
        createdAt: t(2),
        firstName: 'Joana',
        lastName: 'Duarte',
        companyName: 'Zeta Tech',
        email: 'jd@zeta.io',
      }),
      underscore: await insertLead(db.admin, ids, workspaceId, {
        createdAt: t(3),
        firstName: 'Ana',
        lastName: 'Lima',
        companyName: 'Ana_Co',
        email: 'ana_co@x.com',
      }),
      plain: await insertLead(db.admin, ids, workspaceId, {
        createdAt: t(4),
        firstName: 'Ana',
        lastName: 'Lima',
        companyName: 'AnaXCo',
        email: 'anaxco@x.com',
      }),
      percent: await insertLead(db.admin, ids, workspaceId, {
        createdAt: t(5),
        firstName: 'Pedro',
        lastName: 'Alves',
        companyName: '100% Digital',
        email: 'p@100.com',
      }),
      backslash: await insertLead(db.admin, ids, workspaceId, {
        createdAt: t(6),
        firstName: 'Rui',
        lastName: 'Costa',
        companyName: 'C\\Dir Soft',
        email: 'rui@cdir.com',
      }),
    };
  }

  async function searchIds(workspaceId: WorkspaceId, raw: string, limit = 100): Promise<string[]> {
    const { search } = useCases();
    const userId = asUser('0194f1c2-1111-7000-8000-00000000000a');
    const { ids: collected } = await collectAll(async (cursor) => {
      const result = await search({
        workspaceId,
        userId,
        filters: NO_FILTERS,
        term: term(raw),
        limit,
        cursor,
      });
      if (!result.ok) throw new Error('search failed');
      return result.value;
    });
    return collected;
  }

  it('matches a prefix of first name, surname, full name, company or e-mail, case-insensitively', async () => {
    const { workspaceId } = await scope.workspace();
    const people = await seedPeople(workspaceId);

    expect(await searchIds(workspaceId, 'CARL')).toEqual([people.carla.id]);
    expect(await searchIds(workspaceId, 'duar')).toEqual([people.joana.id]);
    expect(await searchIds(workspaceId, 'joana du')).toEqual([people.joana.id]);
    expect(await searchIds(workspaceId, 'zeta')).toEqual([people.joana.id]);
    expect(await searchIds(workspaceId, 'JD@ZETA')).toEqual([people.joana.id]);
    expect(await searchIds(workspaceId, 'eta')).toEqual([]);
    expect(await searchIds(workspaceId, 'menezes')).toEqual([people.carla.id]);
  });

  it('treats %, _ and \\ in the term as literals, never as wildcards', async () => {
    const { workspaceId } = await scope.workspace();
    const people = await seedPeople(workspaceId);

    // `_` must not match "X": only the company with a real underscore (and the e-mail local part) matches.
    expect(await searchIds(workspaceId, 'ana_c')).toEqual([people.underscore.id]);
    expect(await searchIds(workspaceId, 'anaxc')).toEqual([people.plain.id]);
    // `%` alone matches nothing; with text it matches the literal percent sign only.
    expect(await searchIds(workspaceId, '%%')).toEqual([]);
    expect(await searchIds(workspaceId, '100%')).toEqual([people.percent.id]);
    expect(await searchIds(workspaceId, 'a%')).toEqual([]);
    expect(await searchIds(workspaceId, '_a')).toEqual([]);
    expect(await searchIds(workspaceId, 'c\\d')).toEqual([people.backslash.id]);
    expect(await searchIds(workspaceId, '\\\\')).toEqual([]);
  });

  it('is safe against SQL metacharacters in the term', async () => {
    const { workspaceId } = await scope.workspace();
    await seedPeople(workspaceId);

    expect(await searchIds(workspaceId, "' OR 1=1 --")).toEqual([]);
    expect(await searchIds(workspaceId, "x'); DROP TABLE crm.leads; --")).toEqual([]);
    expect(await searchIds(workspaceId, 'carla')).toHaveLength(1);
  });

  it('pages search results with a keyset over created_at and id', async () => {
    const { workspaceId } = await scope.workspace();
    const tie = '2026-11-03T14:00:00.123456Z';
    const seeded: SeededLead[] = [];
    for (let n = 0; n < 7; n += 1) {
      seeded.push(
        await insertLead(db.admin, ids, workspaceId, {
          createdAt: n < 4 ? tie : microsecondsAfter(tie, -n),
          firstName: 'Marta',
        }),
      );
    }

    expect(await searchIds(workspaceId, 'mart', 2)).toEqual(expectedOrder(seeded));
  });
});

describe('workspace isolation over Postgres', () => {
  it('lists and searches only the principal workspace', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const inA = await insertLead(db.admin, ids, a.workspaceId, { firstName: 'Zulmira' });
    const inB = await insertLead(db.admin, ids, b.workspaceId, { firstName: 'Zulmira' });

    expect(await listAll(a.workspaceId, 10)).toEqual([inA.id]);
    expect(await listAll(b.workspaceId, 10)).toEqual([inB.id]);
    const { search } = useCases();
    const found = await search({
      workspaceId: a.workspaceId,
      userId: asUser('0194f1c2-1111-7000-8000-00000000000a'),
      filters: NO_FILTERS,
      term: term('zulm'),
      limit: 10,
      cursor: null,
    });
    expect(found.ok && found.value.items.map((i) => i.id)).toEqual([inA.id]);
  });

  it('answers not_found (never the data) for a lead of another workspace, as for a nonexistent id', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const foreign = await insertLead(db.admin, ids, b.workspaceId);
    const { detail } = useCases();
    const input = {
      workspaceId: a.workspaceId,
      userId: asUser('0194f1c2-1111-7000-8000-00000000000a'),
      activitiesLimit: 20,
      activitiesCursor: null,
    };

    const crossTenant = await detail({ ...input, leadId: foreign.id as LeadId });
    const missing = await detail({ ...input, leadId: ids.uuidv7() as LeadId });

    expect(crossTenant).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(missing).toEqual(crossTenant);
  });

  it('RLS alone hides another workspace even when the query filter is forged (second barrier)', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const foreign = await insertLead(db.admin, ids, b.workspaceId);
    await insertActivity(db.admin, ids, b.workspaceId, foreign.id, {
      type: 'anonymized',
      createdAt: DEFAULT_CREATED_AT,
    });
    const queries = createPostgresLeadQueries();

    // A transaction scoped to A that explicitly asks for B's rows.
    const seen = await uow.run(a.workspaceId, async (tx) => ({
      leads: await queries.listLeads(tx, {
        workspaceId: b.workspaceId,
        filters: { stage: null, owner: null, scoreBand: null, prefix: null },
        limit: 10,
        after: null,
      }),
      profile: await queries.findLeadProfile(tx, b.workspaceId, foreign.id as LeadId),
      submissions: await queries.listSubmissions(tx, b.workspaceId, foreign.id as LeadId, 50),
      consents: await queries.currentConsents(tx, b.workspaceId, foreign.id as LeadId),
      activities: await queries.listActivities(tx, {
        workspaceId: b.workspaceId,
        leadId: foreign.id as LeadId,
        limit: 10,
        after: null,
      }),
    }));

    expect(seen.leads.items).toEqual([]);
    expect(seen.profile).toBeNull();
    expect(seen.submissions).toEqual([]);
    expect(seen.consents).toEqual([]);
    expect(seen.activities.items).toEqual([]);
  });

  it('keeps concurrent requests of two workspaces apart on the same pool', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const leadsA: string[] = [];
    const leadsB: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      leadsA.push(
        (
          await insertLead(db.admin, ids, a.workspaceId, {
            createdAt: microsecondsAfter(DEFAULT_CREATED_AT, n),
          })
        ).id,
      );
      leadsB.push(
        (
          await insertLead(db.admin, ids, b.workspaceId, {
            createdAt: microsecondsAfter(DEFAULT_CREATED_AT, n),
          })
        ).id,
      );
    }

    const rounds = await Promise.all(
      Array.from({ length: 10 }, (_, round) =>
        listAll(round % 2 === 0 ? a.workspaceId : b.workspaceId, 2).then((collected) => ({
          round,
          collected,
        })),
      ),
    );

    for (const { round, collected } of rounds) {
      const expected = round % 2 === 0 ? leadsA : leadsB;
      expect([...collected].sort()).toEqual([...expected].sort());
    }
  });
});

describe('getLeadDetail over Postgres', () => {
  async function leadWithHistory() {
    const fixture = await scope.workspace();
    const lead = await insertLead(db.admin, ids, fixture.workspaceId, { firstName: 'Carla' });
    return { fixture, lead };
  }

  it('never exposes IP, user agent, tracking cookies or click ID values', async () => {
    const { fixture, lead } = await leadWithHistory();
    await insertSubmission(db.admin, ids, fixture, lead.id, {
      clientIp: '203.0.113.77',
      userAgent: 'Mozilla/5.0 (SecretAgent/9.9)',
      gclid: 'GCLID-SECRET-VALUE',
      fbclid: 'FBCLID-SECRET-VALUE',
      fbp: 'fb.1.1700000000000.FBP-SECRET',
      fbc: 'fb.1.1700000000000.FBC-SECRET',
      gaClientId: '1234567890.1700000000',
      utmSource: 'meta',
      message: 'Quero uma demonstração',
      fields: {
        first_name: 'Carla',
        email: 'carla@acme.com.br',
        privacy_consent: true,
        company_size: '51_200',
        marketing_opt_in: true,
      },
    });
    const { detail } = useCases();

    const result = await detail({
      workspaceId: fixture.workspaceId,
      userId: asUser('0194f1c2-1111-7000-8000-00000000000a'),
      leadId: lead.id as LeadId,
      activitiesLimit: 20,
      activitiesCursor: null,
    });
    if (!result.ok) throw new Error('detail failed');
    const json = JSON.stringify(leadDetailJson(result.value));

    for (const secret of [
      '203.0.113.77',
      'SecretAgent',
      'GCLID-SECRET-VALUE',
      'FBCLID-SECRET-VALUE',
      'FBP-SECRET',
      'FBC-SECRET',
      '1234567890.1700000000',
      'client_ip',
      'user_agent',
      'privacy_consent',
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    const submission = result.value.submissions[0];
    expect(submission?.attribution.clickIdTypes).toEqual(['gclid', 'fbclid']);
    expect(submission?.attribution.utmSource).toBe('meta');
    expect(submission?.message).toBe('Quero uma demonstração');
    expect(submission?.fields.companySize).toBe('51_200');
  });

  it('returns at most the 50 most recent submissions', async () => {
    const { fixture, lead } = await leadWithHistory();
    const created: string[] = [];
    for (let n = 0; n < 55; n += 1) {
      created.push(microsecondsAfter(DEFAULT_CREATED_AT, n));
      await insertSubmission(db.admin, ids, fixture, lead.id, {
        createdAt: created[n] ?? DEFAULT_CREATED_AT,
      });
    }
    const { detail } = useCases();

    const result = await detail({
      workspaceId: fixture.workspaceId,
      userId: asUser('0194f1c2-1111-7000-8000-00000000000a'),
      leadId: lead.id as LeadId,
      activitiesLimit: 20,
      activitiesCursor: null,
    });

    expect(result.ok && result.value.submissions).toHaveLength(50);
    const newest = result.ok ? result.value.submissions[0]?.createdAt.getTime() : 0;
    expect(newest).toBe(new Date(created[54] ?? '').getTime());
  });

  it('reports the latest consent per purpose', async () => {
    const { fixture, lead } = await leadWithHistory();
    const submissionId = await insertSubmission(db.admin, ids, fixture, lead.id);
    const seed = (
      purpose: 'privacy_policy' | 'marketing_communications' | 'ad_tracking',
      granted: boolean,
      createdAt: string,
      policyVersion = '2026-11-03',
    ) =>
      insertConsent(db.admin, ids, fixture.workspaceId, lead.id, submissionId, {
        purpose,
        granted,
        createdAt,
        policyVersion,
      });
    await seed('privacy_policy', true, microsecondsAfter(DEFAULT_CREATED_AT, 1), '2026-11-01');
    await seed('privacy_policy', true, microsecondsAfter(DEFAULT_CREATED_AT, 2), '2026-11-03');
    await seed('marketing_communications', true, microsecondsAfter(DEFAULT_CREATED_AT, 1));
    await seed('marketing_communications', false, microsecondsAfter(DEFAULT_CREATED_AT, 5));
    const { detail } = useCases();

    const result = await detail({
      workspaceId: fixture.workspaceId,
      userId: asUser('0194f1c2-1111-7000-8000-00000000000a'),
      leadId: lead.id as LeadId,
      activitiesLimit: 20,
      activitiesCursor: null,
    });
    if (!result.ok) throw new Error('detail failed');

    expect(result.value.consents.map((c) => [c.purpose, c.granted, c.policyVersion])).toEqual([
      ['marketing_communications', false, '2026-11-03'],
      ['privacy_policy', true, '2026-11-03'],
    ]);
  });

  it('pages the timeline newest first with ties on created_at broken by id descending', async () => {
    const { fixture, lead } = await leadWithHistory();
    const tie = '2026-11-03T14:00:00.123456Z';
    const seeded: { id: string; createdAt: string }[] = [];
    const stamps = [
      tie,
      tie,
      tie,
      microsecondsAfter(tie, 1),
      microsecondsAfter(tie, -1),
      microsecondsAfter(tie, -1),
      microsecondsAfter(tie, 100),
    ];
    for (const createdAt of stamps) {
      const id = await insertActivity(db.admin, ids, fixture.workspaceId, lead.id, {
        type: 'note_added',
        createdAt,
        data: { body: 'x' },
      });
      seeded.push({ id, createdAt });
    }
    const expected = [...seeded]
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? compareText(b.id, a.id)
          : compareText(b.createdAt, a.createdAt),
      )
      .map((row) => row.id);
    const { detail } = useCases();
    const userId = asUser('0194f1c2-1111-7000-8000-00000000000a');

    for (const limit of [1, 2, 3, 100]) {
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const result = await detail({
          workspaceId: fixture.workspaceId,
          userId,
          leadId: lead.id as LeadId,
          activitiesLimit: limit,
          activitiesCursor: cursor,
        });
        if (!result.ok) throw new Error('detail failed');
        collected.push(...result.value.activities.items.map((a) => a.id));
        cursor = result.value.activities.nextCursor;
        if (cursor === null) break;
      }
      expect(collected, `limit ${String(limit)}`).toEqual(expected);
    }
  });

  it('maps the stored activity payloads to the contract shape and drops unknown keys', async () => {
    const { fixture, lead } = await leadWithHistory();
    const owner = '0194f1c2-1111-7000-8000-00000000000c';
    await insertActivity(db.admin, ids, fixture.workspaceId, lead.id, {
      type: 'stage_changed',
      createdAt: microsecondsAfter(DEFAULT_CREATED_AT, 1),
      actorType: 'user',
      actorId: owner,
      data: { from: 'new', to: 'lost', lost_reason: 'timing', email: 'leak@example.com' },
    });
    await insertActivity(db.admin, ids, fixture.workspaceId, lead.id, {
      type: 'owner_assigned',
      createdAt: microsecondsAfter(DEFAULT_CREATED_AT, 2),
      actorType: 'user',
      actorId: owner,
      data: { previous_owner_id: null, owner_id: owner },
    });
    const { detail } = useCases();

    const result = await detail({
      workspaceId: fixture.workspaceId,
      userId: asUser(owner),
      leadId: lead.id as LeadId,
      activitiesLimit: 20,
      activitiesCursor: null,
    });
    if (!result.ok) throw new Error('detail failed');

    expect(result.value.activities.items.map((a) => [a.type, a.data])).toEqual([
      ['owner_assigned', { from_owner_user_id: null, to_owner_user_id: owner }],
      ['stage_changed', { from_stage: 'new', to_stage: 'lost', lost_reason: 'timing' }],
    ]);
  });
});

describe('CRM read routes over Postgres conform to the contract', () => {
  async function seeded(): Promise<{ fixture: WorkspaceFixture; lead: SeededLead }> {
    const fixture = await scope.workspace();
    const lead = await insertLead(db.admin, ids, fixture.workspaceId, {
      firstName: 'Carla',
      stage: 'lost',
      ownerUserId: '0194f1c2-1111-7000-8000-00000000000a',
    });
    for (let n = 1; n < 30; n += 1) {
      await insertLead(db.admin, ids, fixture.workspaceId, {
        createdAt: microsecondsAfter(DEFAULT_CREATED_AT, -n),
      });
    }
    const submissionId = await insertSubmission(db.admin, ids, fixture, lead.id, {
      clientIp: '203.0.113.77',
      userAgent: 'SecretAgent',
      gclid: 'GCLID-SECRET',
      fbp: 'fb.1.1700000000000.X',
      fields: {
        first_name: 'Carla',
        area_of_expertise: 'technology',
        marketing_opt_in: true,
        privacy_consent: true,
      },
    });
    await insertConsent(db.admin, ids, fixture.workspaceId, lead.id, submissionId, {
      purpose: 'privacy_policy',
      granted: true,
      createdAt: DEFAULT_CREATED_AT,
    });
    await insertActivity(db.admin, ids, fixture.workspaceId, lead.id, {
      type: 'submission_received',
      createdAt: DEFAULT_CREATED_AT,
      data: { submission_id: submissionId, score: 80, score_band: 'A', submissions_count: 1 },
    });
    await insertActivity(db.admin, ids, fixture.workspaceId, lead.id, {
      type: 'score_changed',
      createdAt: microsecondsAfter(DEFAULT_CREATED_AT, 1),
      data: { from_band: 'C', to_band: 'A', score: 80 },
    });
    return { fixture, lead };
  }

  it('serves list, search and detail from real rows with schema-valid, PII-minimal bodies', async () => {
    const { fixture, lead } = await seeded();
    const harness = buildReadAppOn(createPostgresLeadQueries(), uow, {
      principal: aPrincipal({
        workspaceId: fixture.workspaceId,
        userId: asUser('0194f1c2-1111-7000-8000-00000000000a'),
      }),
    });
    const responses = [
      { path: '/v1/crm/leads', method: 'get', response: await harness.get(LIST_PATH) },
      {
        path: '/v1/crm/leads',
        method: 'get',
        response: await harness.get(`${LIST_PATH}?limit=100&owner=me&stage=lost`),
      },
      {
        path: '/v1/crm/leads/search',
        method: 'post',
        response: await harness.post(SEARCH_PATH, { q: 'carl' }),
      },
      {
        path: '/v1/crm/leads/{id}',
        method: 'get',
        response: await harness.get(detailPath(lead.id)),
      },
      {
        path: '/v1/crm/leads/{id}',
        method: 'get',
        response: await harness.get(`${detailPath(lead.id)}?activities_limit=1`),
      },
    ] as const;

    for (const { path, method, response } of responses) {
      const bodyText = await response.text();
      expect(response.status).toBe(200);
      expect(
        contract.responseProblems(path, method, {
          status: response.status,
          headers: response.headers,
          bodyText,
        }),
      ).toEqual([]);
      for (const secret of [
        '203.0.113.77',
        'SecretAgent',
        'GCLID-SECRET',
        'fb.1.1700000000000.X',
      ]) {
        expect(bodyText).not.toContain(secret);
      }
    }
  });

  it('answers 404 for a lead of another workspace through HTTP', async () => {
    const mine = await scope.workspace();
    const { lead } = await seeded();
    const harness = buildReadAppOn(createPostgresLeadQueries(), uow, {
      principal: aPrincipal({ workspaceId: mine.workspaceId }),
    });

    const response = await harness.get(detailPath(lead.id));

    expect(response.status).toBe(404);
    expect(
      contract.responseProblems('/v1/crm/leads/{id}', 'get', {
        status: 404,
        headers: response.headers,
        bodyText: await response.text(),
      }),
    ).toEqual([]);
  });
});
