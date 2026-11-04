import { beforeEach, describe, expect, it } from 'vitest';
import type { StaffRole } from '#/platform/auth/staff.ts';
import { CRM_READ_ROLES } from '#/modules/crm/presentation/read-routes.ts';
import { WORKSPACE_A, WORKSPACE_B, aProfile } from '#test/fakes/crm-read.ts';
import {
  LIST_PATH,
  SEARCH_PATH,
  aPrincipal,
  buildReadApp,
  detailPath,
  type ReadApp,
} from './read-app.ts';

const T0 = new Date('2026-11-03T14:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const leadId = (n: number): string => `0194f1c2-aaaa-7000-8000-${n.toString().padStart(12, '0')}`;
const FOREIGN_LEAD_ID = '0194f1c2-dddd-7000-8000-000000000001';
const MISSING_LEAD_ID = '0194f1c2-eeee-7000-8000-000000000001';

interface ProblemBody {
  readonly code: string;
  readonly status: number;
  readonly errors?: readonly { field: string; code: string }[];
}

let harness: ReadApp;

function seed(count: number): void {
  for (let n = 1; n <= count; n += 1) {
    harness.queries.addLead(WORKSPACE_A, aProfile(leadId(n), at(-n * 10)));
  }
}

async function problem(response: Response): Promise<ProblemBody> {
  expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  return (await response.json()) as ProblemBody;
}

beforeEach(() => {
  harness = buildReadApp();
  harness.queries.addLead(WORKSPACE_B, aProfile(FOREIGN_LEAD_ID, at(5), { firstName: 'Intruder' }));
});

describe('authorization matrix', () => {
  const requests: readonly {
    readonly name: string;
    readonly run: (h: ReadApp) => Promise<Response>;
  }[] = [
    { name: 'GET /v1/crm/leads', run: (h) => h.get(LIST_PATH) },
    { name: 'POST /v1/crm/leads/search', run: (h) => h.post(SEARCH_PATH, { q: 'ca' }) },
    { name: 'GET /v1/crm/leads/{id}', run: (h) => h.get(detailPath(leadId(1))) },
  ];

  beforeEach(() => {
    seed(2);
  });

  describe.each(requests)('$name', ({ run }) => {
    it.each(CRM_READ_ROLES)('allows the %s role', async (role) => {
      harness.setRole(role);

      const response = await run(harness);

      expect(response.status).toBe(200);
    });

    it('rejects a role outside the allowlist with 403 forbidden, before touching data', async () => {
      harness.setRole('guest' as StaffRole);

      const response = await run(harness);

      expect(response.status).toBe(403);
      expect((await problem(response)).code).toBe('forbidden');
      expect(harness.queries.calls).toHaveLength(0);
    });

    it('answers 401 without a principal, before touching data', async () => {
      harness.setPrincipal(null);

      const response = await run(harness);

      expect(response.status).toBe(401);
      expect((await problem(response)).code).toBe('unauthorized');
      expect(harness.queries.calls).toHaveLength(0);
    });

    it('runs authenticate, then the read rate limit (fail-open), then the use case', async () => {
      await run(harness);

      expect(harness.guardCalls).toEqual(['authenticate', 'rateLimit']);
      expect(harness.rateLimits).toEqual([{ bucket: 'read', fail: 'open' }]);
    });
  });

  it('reports the read roles as the four workspace roles (contract x-roles)', () => {
    expect([...CRM_READ_ROLES].sort()).toEqual(['admin', 'owner', 'sales', 'viewer']);
  });
});

describe('GET /v1/crm/leads', () => {
  it('returns 25 items by default and a cursor that continues the list', async () => {
    seed(30);

    const first = (await (await harness.get(LIST_PATH)).json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    const second = (await (
      await harness.get(`${LIST_PATH}?cursor=${first.next_cursor ?? ''}`)
    ).json()) as { items: { id: string }[]; next_cursor: string | null };

    expect(first.items).toHaveLength(25);
    expect(first.next_cursor).not.toBeNull();
    expect(second.items).toHaveLength(5);
    expect(second.next_cursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      Array.from({ length: 30 }, (_, n) => leadId(n + 1)),
    );
  });

  it('honors limit up to 100', async () => {
    seed(30);

    const body = (await (await harness.get(`${LIST_PATH}?limit=100`)).json()) as {
      items: unknown[];
    };

    expect(body.items).toHaveLength(30);
  });

  it('applies the stage, owner and score_band filters', async () => {
    seed(3);
    harness.queries.addLead(
      WORKSPACE_A,
      aProfile(leadId(50), at(1), {
        stage: 'won',
        scoreBand: 'C',
        ownerUserId: aPrincipal().userId,
      }),
    );

    const ids = async (query: string): Promise<string[]> => {
      const body = (await (await harness.get(`${LIST_PATH}?${query}`)).json()) as {
        items: { id: string }[];
      };
      return body.items.map((item) => item.id);
    };

    expect(await ids('stage=won')).toEqual([leadId(50)]);
    expect(await ids('score_band=C')).toEqual([leadId(50)]);
    expect(await ids('owner=me')).toEqual([leadId(50)]);
    expect(await ids('owner=unassigned')).toHaveLength(3);
    expect(await ids('stage=won&owner=unassigned')).toEqual([]);
  });

  it.each([
    ['limit=0', 'limit', 'invalid_format'],
    ['limit=101', 'limit', 'invalid_format'],
    ['limit=-1', 'limit', 'invalid_format'],
    ['limit=1.5', 'limit', 'invalid_format'],
    ['limit=abc', 'limit', 'invalid_format'],
    ['limit=', 'limit', 'invalid_format'],
    ['stage=archived', 'stage', 'invalid_choice'],
    ['stage=', 'stage', 'invalid_choice'],
    ['score_band=D', 'score_band', 'invalid_choice'],
    ['owner=somebody', 'owner', 'invalid_format'],
    ['owner=0194F1C2-1111-7000-8000-00000000000A', 'owner', 'invalid_format'],
    ['cursor=', 'cursor', 'too_short'],
    ['cursor=has space', 'cursor', 'invalid_format'],
    [`cursor=${'a'.repeat(513)}`, 'cursor', 'too_long'],
  ])('rejects %s with 400 validation_failed on %s', async (query, field, code) => {
    seed(1);

    const response = await harness.get(`${LIST_PATH}?${query}`);

    expect(response.status).toBe(400);
    const body = await problem(response);
    expect(body.code).toBe('validation_failed');
    expect(body.errors).toContainEqual({ field, code });
    expect(harness.queries.calls).toHaveLength(0);
  });

  it.each(['q', 'workspace_id', 'tenant', 'sort', 'offset', 'access_token', '__proto__'])(
    'rejects the unknown query parameter %s (no free text search, no tenant selection)',
    async (name) => {
      const response = await harness.get(`${LIST_PATH}?${name}=x`);

      expect(response.status).toBe(400);
      const body = await problem(response);
      expect(body.code).toBe('validation_failed');
      expect(body.errors).toContainEqual({ field: name, code: 'not_allowed' });
    },
  );

  it('rejects a repeated parameter instead of silently picking one value', async () => {
    const response = await harness.get(`${LIST_PATH}?limit=1&limit=2`);

    expect(response.status).toBe(400);
    expect((await problem(response)).errors).toContainEqual({
      field: 'limit',
      code: 'not_allowed',
    });
  });

  it('rejects a tampered cursor with 400 and does not echo it', async () => {
    seed(30);
    const first = (await (await harness.get(`${LIST_PATH}?limit=1`)).json()) as {
      next_cursor: string;
    };
    const tampered = `${first.next_cursor.slice(0, -3)}AAA`;

    const response = await harness.get(`${LIST_PATH}?cursor=${tampered}`);

    expect(response.status).toBe(400);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('validation_failed');
    expect(text).not.toContain(tampered);
  });

  it('rejects a cursor replayed with other filters', async () => {
    seed(30);
    const first = (await (await harness.get(`${LIST_PATH}?limit=1`)).json()) as {
      next_cursor: string;
    };

    const response = await harness.get(
      `${LIST_PATH}?limit=1&stage=won&cursor=${first.next_cursor}`,
    );

    expect(response.status).toBe(400);
    expect((await problem(response)).errors).toContainEqual({
      field: 'cursor',
      code: 'invalid_format',
    });
  });

  it('rejects a cursor minted for another user', async () => {
    seed(30);
    const first = (await (await harness.get(`${LIST_PATH}?limit=1`)).json()) as {
      next_cursor: string;
    };
    harness.setPrincipal(aPrincipal({ userId: '0194f1c2-1111-7000-8000-0000000000ff' as never }));

    const response = await harness.get(`${LIST_PATH}?limit=1&cursor=${first.next_cursor}`);

    expect(response.status).toBe(400);
  });

  it('shows only the workspace of the principal (cross-tenant)', async () => {
    seed(2);
    harness.setPrincipal(aPrincipal({ workspaceId: WORKSPACE_B }));

    const body = (await (await harness.get(LIST_PATH)).json()) as {
      items: { id: string; first_name: string }[];
    };

    expect(body.items.map((item) => item.id)).toEqual([FOREIGN_LEAD_ID]);
    expect(harness.unitOfWork.scopes).toEqual([WORKSPACE_B]);
  });

  it('responds with the lead summary fields only (no WhatsApp, message, attribution, IP or UA)', async () => {
    seed(1);

    const body = (await (await harness.get(LIST_PATH)).json()) as {
      items: Record<string, unknown>[];
    };

    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      [
        'id',
        'first_name',
        'last_name',
        'email',
        'company_name',
        'job_title',
        'area_of_expertise',
        'company_size',
        'stage',
        'lost_reason',
        'score',
        'score_band',
        'owner_user_id',
        'submissions_count',
        'first_submitted_at',
        'last_submitted_at',
        'created_at',
        'updated_at',
        'anonymized_at',
        'version',
      ].sort(),
    );
  });

  it('sends the platform security headers, no-store and the correlation id', async () => {
    const response = await harness.get(LIST_PATH);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('POST /v1/crm/leads/search', () => {
  beforeEach(() => {
    seed(3);
    harness.queries.addLead(
      WORKSPACE_A,
      aProfile(leadId(60), at(60), { firstName: 'Joana', email: 'joana@zeta.io' }),
    );
  });

  it('finds leads by prefix and pages with the cursor in the body', async () => {
    const first = (await (await harness.post(SEARCH_PATH, { q: 'ca', limit: 2 })).json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    const second = (await (
      await harness.post(SEARCH_PATH, { q: 'ca', limit: 2, cursor: first.next_cursor })
    ).json()) as { items: { id: string }[]; next_cursor: string | null };

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(harness.logLines.join('')).not.toContain(first.next_cursor ?? 'impossible');
  });

  it('matches e-mail prefixes and combines the term with filters', async () => {
    const byEmail = (await (await harness.post(SEARCH_PATH, { q: 'joana@' })).json()) as {
      items: { id: string }[];
    };
    const filtered = (await (
      await harness.post(SEARCH_PATH, { q: 'joana', stage: 'won' })
    ).json()) as { items: unknown[] };

    expect(byEmail.items.map((item) => item.id)).toEqual([leadId(60)]);
    expect(filtered.items).toEqual([]);
  });

  it('accepts a body without q (same as the list) and an empty object', async () => {
    const response = await harness.post(SEARCH_PATH, {});

    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(4);
  });

  it('treats LIKE wildcards as ordinary characters', async () => {
    const percent = await harness.post(SEARCH_PATH, { q: '%%' });
    const underscore = await harness.post(SEARCH_PATH, { q: '_a' });

    expect(((await percent.json()) as { items: unknown[] }).items).toEqual([]);
    expect(((await underscore.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it.each([
    [{ q: 'a' }, 'q', 'too_short'],
    [{ q: ' a ' }, 'q', 'too_short'],
    [{ q: '' }, 'q', 'too_short'],
    [{ q: 'x'.repeat(81) }, 'q', 'too_long'],
    [{ q: 'ab​cd' }, 'q', 'not_allowed_characters'],
    [{ q: 42 }, 'q', 'invalid_format'],
    [{ q: null }, 'q', 'invalid_format'],
    [{ q: 'ca', workspace_id: WORKSPACE_B }, 'workspace_id', 'not_allowed'],
    [{ q: 'ca', limit: 101 }, 'limit', 'invalid_format'],
    [{ q: 'ca', limit: '5' }, 'limit', 'invalid_format'],
    [{ q: 'ca', stage: 'archived' }, 'stage', 'invalid_choice'],
    [{ q: 'ca', cursor: 'bad cursor' }, 'cursor', 'invalid_format'],
  ])('rejects %j with 400 on %s (%s)', async (body, field, code) => {
    const response = await harness.post(SEARCH_PATH, body);

    expect(response.status).toBe(400);
    const parsed = await problem(response);
    expect(parsed.code).toBe('validation_failed');
    expect(parsed.errors).toContainEqual({ field, code });
  });

  it('rejects malformed JSON with 400 invalid_json and a non-JSON content type with 415', async () => {
    const malformed = await harness.post(SEARCH_PATH, '{"q":');
    const wrongType = await harness.post(SEARCH_PATH, '{"q":"ca"}', {
      'Content-Type': 'text/plain',
    });
    const empty = await harness.post(SEARCH_PATH, '');

    expect(malformed.status).toBe(400);
    expect((await problem(malformed)).code).toBe('invalid_json');
    expect(wrongType.status).toBe(415);
    expect((await problem(wrongType)).code).toBe('unsupported_media_type');
    expect(empty.status).toBe(400);
  });

  it('rejects a body above 16 KB with 413 before parsing', async () => {
    const response = await harness.post(SEARCH_PATH, { q: 'a'.repeat(20 * 1024) });

    expect(response.status).toBe(413);
    expect((await problem(response)).code).toBe('payload_too_large');
  });

  it('answers 401 for an unauthenticated request even with an invalid body', async () => {
    harness.setPrincipal(null);

    const response = await harness.post(SEARCH_PATH, '{"q":');

    expect(response.status).toBe(401);
  });

  it('keeps the search term and the cursors out of the logs', async () => {
    const term = 'secret.person@example.com';

    const first = await harness.post(SEARCH_PATH, { q: term, limit: 1 });
    await harness.post(SEARCH_PATH, { q: `${term}-too-long`.padEnd(100, 'x') });

    expect(first.status).toBe(200);
    expect(harness.logLines.join('')).not.toContain('secret.person');
  });

  it('is scoped to the principal workspace', async () => {
    harness.setPrincipal(aPrincipal({ workspaceId: WORKSPACE_B }));

    const body = (await (await harness.post(SEARCH_PATH, { q: 'intr' })).json()) as {
      items: { id: string }[];
    };
    harness.setPrincipal(aPrincipal({ workspaceId: WORKSPACE_A }));
    const none = (await (await harness.post(SEARCH_PATH, { q: 'intr' })).json()) as {
      items: unknown[];
    };

    expect(body.items.map((item) => item.id)).toEqual([FOREIGN_LEAD_ID]);
    expect(none.items).toEqual([]);
  });
});

describe('GET /v1/crm/leads/{id}', () => {
  beforeEach(() => {
    const activities = Array.from({ length: 5 }, (_, n) => ({
      id: `0194f1c2-bbbb-7000-8000-${(n + 1).toString().padStart(12, '0')}`,
      type: 'note_added' as const,
      actorType: 'user' as const,
      actorId: aPrincipal().userId,
      createdAt: at(n),
      data: { body: `<script>alert(${String(n)})</script>` },
    }));
    harness.queries.addLead(WORKSPACE_A, aProfile(leadId(1), at(0)), { activities });
  });

  it('returns the detail with the first page of activities and a cursor to the next', async () => {
    const first = (await (
      await harness.get(`${detailPath(leadId(1))}?activities_limit=2`)
    ).json()) as {
      lead: { id: string };
      activities: { items: { id: string }[]; next_cursor: string | null };
    };
    const second = (await (
      await harness.get(
        `${detailPath(leadId(1))}?activities_limit=100&activities_cursor=${first.activities.next_cursor ?? ''}`,
      )
    ).json()) as { activities: { items: { id: string }[]; next_cursor: string | null } };

    expect(first.lead.id).toBe(leadId(1));
    expect(first.activities.items).toHaveLength(2);
    expect(second.activities.items).toHaveLength(3);
    expect(second.activities.next_cursor).toBeNull();
  });

  it('returns untrusted note text verbatim as JSON (escaping is the UI job)', async () => {
    const response = await harness.get(detailPath(leadId(1)));
    const body = (await response.json()) as {
      activities: { items: { data: { body: string } }[] };
    };

    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(body.activities.items.map((a) => a.data.body)).toContain('<script>alert(4)</script>');
  });

  it('answers 404 not_found for another workspace and for a nonexistent id, identically', async () => {
    const foreign = await harness.get(detailPath(FOREIGN_LEAD_ID));
    const missing = await harness.get(detailPath(MISSING_LEAD_ID));

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const foreignBody = await problem(foreign);
    const missingBody = await problem(missing);
    expect({ ...foreignBody, correlation_id: undefined }).toEqual({
      ...missingBody,
      correlation_id: undefined,
    });
    expect(foreignBody.code).toBe('not_found');
    expect([...foreign.headers.keys()].filter((name) => name !== 'x-request-id').sort()).toEqual(
      [...missing.headers.keys()].filter((name) => name !== 'x-request-id').sort(),
    );
  });

  it('never answers 403 for a lead of another workspace, whatever the role', async () => {
    for (const role of CRM_READ_ROLES) {
      harness.setRole(role);
      expect((await harness.get(detailPath(FOREIGN_LEAD_ID))).status).toBe(404);
    }
  });

  it.each([
    'abc',
    '123',
    '0194f1c2-aaaa-7000-8000-00000000000',
    '0194f1c2-aaaa-7000-8000-0000000000000',
  ])('rejects the malformed id %s with 400 on id', async (id) => {
    const response = await harness.get(detailPath(id));

    expect(response.status).toBe(400);
    expect((await problem(response)).errors).toContainEqual({
      field: 'id',
      code: 'invalid_format',
    });
    expect(harness.queries.calls).toHaveLength(0);
  });

  it.each([
    ['activities_limit=0', 'activities_limit', 'invalid_format'],
    ['activities_limit=101', 'activities_limit', 'invalid_format'],
    ['activities_limit=x', 'activities_limit', 'invalid_format'],
    ['activities_cursor=bad cursor', 'activities_cursor', 'invalid_format'],
    ['limit=5', 'limit', 'not_allowed'],
    ['workspace_id=x', 'workspace_id', 'not_allowed'],
  ])('rejects %s with 400', async (query, field, code) => {
    const response = await harness.get(`${detailPath(leadId(1))}?${query}`);

    expect(response.status).toBe(400);
    expect((await problem(response)).errors).toContainEqual({ field, code });
  });

  it('rejects a forged activities cursor with 400 on activities_cursor', async () => {
    const response = await harness.get(
      `${detailPath(leadId(1))}?activities_cursor=eyJjIjoiMjAyNiJ9.AAAA`,
    );

    expect(response.status).toBe(400);
    expect((await problem(response)).errors).toContainEqual({
      field: 'activities_cursor',
      code: 'invalid_format',
    });
  });

  it('does not capture sibling literal routes such as export.csv', async () => {
    const response = await harness.get('/v1/crm/leads/export.csv');

    expect(response.status).toBe(404);
    expect((await problem(response)).code).toBe('not_found');
    expect(harness.guardCalls).toEqual([]);
  });
});
