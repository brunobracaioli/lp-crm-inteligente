import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  AUTH_NOW_SECONDS,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_A,
  WORKSPACE_B,
  mintToken,
  unsecuredToken,
} from '#test/fakes/staff-auth.ts';
import { bearer, buildStaffApp, type StaffApp } from '#test/fakes/staff-app.ts';
import { extractBearerToken } from './staff-guards.ts';
import { STAFF_RATE_LIMITS } from './staff-rate-limiter.ts';
import { requireRole, type StaffEnv, type StaffGuards } from './staff.ts';

interface ProblemBody {
  code: string;
  status: number;
  correlation_id: string;
  [key: string]: unknown;
}

async function problem(response: Response): Promise<ProblemBody> {
  return (await response.json()) as ProblemBody;
}

/** Body without the per-request correlation id: what must be identical across failure reasons. */
async function anonymousBody(response: Response): Promise<Omit<ProblemBody, 'correlation_id'>> {
  const body = await problem(response);
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'correlation_id'));
}

const whoami = '/v1/crm/whoami';

function routesWithBuckets(guards: StaffGuards): Hono<StaffEnv> {
  return new Hono<StaffEnv>()
    .get('/v1/crm/whoami', guards.authenticate, (c) => c.json(c.get('staff')))
    .get('/v1/crm/read', guards.authenticate, guards.rateLimit('read', 'open'), (c) =>
      c.json({ ok: true }),
    )
    .get('/v1/crm/write', guards.authenticate, guards.rateLimit('write', 'open'), (c) =>
      c.json({ ok: true }),
    )
    .get('/v1/crm/export', guards.authenticate, guards.rateLimit('export', 'closed'), (c) =>
      c.json({ ok: true }),
    )
    .get(
      '/v1/crm/admin',
      guards.authenticate,
      guards.rateLimit('read', 'open'),
      requireRole('owner', 'admin'),
      (c) => c.json({ ok: true }),
    );
}

describe('extractBearerToken', () => {
  it.each([
    ['Bearer a.b.c', 'a.b.c'],
    ['bearer a-_9.b.c', 'a-_9.b.c'],
    ['BEARER x.y.z', 'x.y.z'],
  ])('accepts %j', (header, token) => {
    expect(extractBearerToken(header)).toBe(token);
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    'Bearer a.b',
    'Bearer a.b.c.d',
    'Bearer  a.b.c',
    'Bearer a.b.c ',
    'Bearer a.b.c, Bearer d.e.f',
    'Basic dXNlcjpwYXNz',
    'Token a.b.c',
    'a.b.c',
    `Bearer ${'a'.repeat(5000)}.b.c`,
  ])('rejects %j', (header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});

describe('authenticate: credential extraction and generic 401 (ST-06, ST-07)', () => {
  it('answers 401 with WWW-Authenticate and the same body for every kind of bad credential', async () => {
    const t = await buildStaffApp();
    const valid = await mintToken({ key: t.es });
    const duplicate = new Headers([
      ['Authorization', `Bearer ${valid}`],
      ['Authorization', `Bearer ${valid}`],
    ]);
    const attempts: RequestInit[] = [
      {},
      { headers: { Authorization: 'Basic dXNlcjpwYXNz' } },
      { headers: { Authorization: 'Bearer ' } },
      { headers: { Authorization: 'Bearer garbage' } },
      { headers: duplicate },
      bearer(unsecuredToken()),
      bearer(await mintToken({ key: t.es, claims: { exp: AUTH_NOW_SECONDS - 60 } })),
      bearer(await mintToken({ key: t.es, claims: { iss: 'https://other.supabase.co/auth/v1' } })),
      bearer(await mintToken({ key: t.es, claims: { aud: 'anon' } })),
      bearer(await mintToken({ key: t.es, kid: 'unknown' })),
      bearer(await mintToken({ key: t.es, claims: { is_anonymous: true } })),
    ];

    const bodies: unknown[] = [];
    for (const init of attempts) {
      const response = await t.app.request(whoami, init);
      expect(response.status, JSON.stringify(init.headers)).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
      expect(response.headers.get('Content-Type')).toContain('application/problem+json');
      bodies.push(await anonymousBody(response));
    }

    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(t.memberships.lookups).toHaveLength(0);
  });

  it('ignores a valid token in the query string and in a cookie', async () => {
    const t = await buildStaffApp();
    const token = await mintToken({ key: t.es });

    const viaQuery = await t.app.request(`${whoami}?access_token=${token}&token=${token}`);
    const viaCookie = await t.app.request(whoami, {
      headers: { Cookie: `sb-access-token=${token}; access_token=${token}` },
    });

    expect(viaQuery.status).toBe(401);
    expect(viaCookie.status).toBe(401);
  });

  it('answers 401 for an invalid body before anything else (no 400 without a credential)', async () => {
    const t = await buildStaffApp({
      routes: (guards) =>
        new Hono<StaffEnv>().post('/v1/crm/echo', guards.authenticate, async (c) =>
          c.json(await c.req.json()),
        ),
    });

    const response = await t.app.request('/v1/crm/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken',
    });

    expect(response.status).toBe(401);
  });

  it('never logs the token, not even for a rejected one', async () => {
    const t = await buildStaffApp();
    const good = await mintToken({ key: t.es });
    const expired = await mintToken({ key: t.es, claims: { exp: AUTH_NOW_SECONDS - 60 } });

    await t.app.request(whoami, bearer(good));
    await t.app.request(whoami, bearer(expired));
    await t.app.request(whoami, bearer('not.a.token'));

    const logs = t.logLines.join('');
    expect(logs).not.toContain(good);
    expect(logs).not.toContain(expired);
    expect(logs).not.toContain(good.split('.')[1] ?? 'unreachable');
    expect(logs).not.toContain('vendedora@empresa.com.br');
  });

  it('records a low-cardinality rejection metric without the token', async () => {
    const t = await buildStaffApp();
    const expired = await mintToken({ key: t.es, claims: { exp: AUTH_NOW_SECONDS - 60 } });
    await t.app.request(whoami, bearer(expired));
    await t.app.request(whoami);

    expect(t.metrics.records.map((r) => [r.name, r.attributes?.reason])).toEqual([
      ['auth.staff_rejected', 'expired'],
      ['auth.staff_rejected', 'missing_credential'],
    ]);
  });
});

describe('authenticate: identity provider unavailable (ST-05)', () => {
  it('answers 503 with Retry-After when the JWKS is down and nothing is cached', async () => {
    const t = await buildStaffApp();
    t.endpoint.mode = 'down';

    const response = await t.app.request(whoami, bearer(await mintToken({ key: t.es })));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(await problem(response)).toMatchObject({ code: 'service_unavailable' });
  });

  it('keeps serving authenticated requests from the cached keys', async () => {
    const t = await buildStaffApp();
    const token = await mintToken({ key: t.es });
    expect((await t.app.request(whoami, bearer(token))).status).toBe(200);
    t.endpoint.mode = 'down';

    expect((await t.app.request(whoami, bearer(token))).status).toBe(200);
  });
});

describe('authenticate: membership decides workspace and role (ST-08, ST-09)', () => {
  it('builds the principal from the membership row, not from the token', async () => {
    const t = await buildStaffApp();
    const token = await mintToken({
      key: t.es,
      claims: {
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: AUTH_NOW_SECONDS - 120 }],
        app_metadata: { role: 'owner', workspace_id: WORKSPACE_B },
        user_metadata: { role: 'owner', workspace_id: WORKSPACE_B },
        workspace_id: WORKSPACE_B,
      },
    });

    const response = await t.app.request(whoami, bearer(token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: USER_ID,
      workspaceId: WORKSPACE_A,
      role: 'sales',
      displayName: 'Marina Souza',
      aal: 'aal2',
      mfaVerifiedAt: new Date((AUTH_NOW_SECONDS - 120) * 1000).toISOString(),
    });
  });

  it('ignores a workspace chosen by the client in query, header or path', async () => {
    const t = await buildStaffApp();
    const token = await mintToken({ key: t.es });

    const response = await t.app.request(
      `${whoami}?workspace_id=${WORKSPACE_B}&tenant=${WORKSPACE_B}`,
      bearer(token, { 'X-Workspace-Id': WORKSPACE_B, 'X-Tenant-Id': WORKSPACE_B }),
    );

    expect(((await response.json()) as { workspaceId: string }).workspaceId).toBe(WORKSPACE_A);
  });

  it('answers 403 forbidden for a valid token without an active membership', async () => {
    const t = await buildStaffApp();
    const token = await mintToken({ key: t.es, claims: { sub: OTHER_USER_ID } });

    const response = await t.app.request(whoami, bearer(token));

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: 'forbidden' });
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('cuts access on the very next request when the member is deactivated', async () => {
    const t = await buildStaffApp();
    const token = await mintToken({ key: t.es });
    expect((await t.app.request(whoami, bearer(token))).status).toBe(200);

    t.memberships.set(USER_ID, { kind: 'none' });

    expect((await t.app.request(whoami, bearer(token))).status).toBe(403);
    expect(t.memberships.lookups).toHaveLength(2);
  });

  it('fails closed with 403 when the user has more than one active membership', async () => {
    const t = await buildStaffApp();
    t.memberships.set(USER_ID, { kind: 'ambiguous' });

    const response = await t.app.request(whoami, bearer(await mintToken({ key: t.es })));

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: 'forbidden' });
  });

  it('does not tell a missing membership from an ambiguous one in the response', async () => {
    const t = await buildStaffApp();
    const token = await mintToken({ key: t.es });
    t.memberships.set(USER_ID, { kind: 'none' });
    const none = await anonymousBody(await t.app.request(whoami, bearer(token)));
    t.memberships.set(USER_ID, { kind: 'ambiguous' });
    const ambiguous = await anonymousBody(await t.app.request(whoami, bearer(token)));

    expect(ambiguous).toEqual(none);
  });
});

describe('role guard after authentication (ST-09, ST-10)', () => {
  it('returns 403 forbidden to a role outside the allowlist, even if a claim says owner', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    const token = await mintToken({
      key: t.es,
      claims: { app_metadata: { role: 'owner' }, user_metadata: { role: 'owner' } },
    });

    const response = await t.app.request('/v1/crm/admin', bearer(token));

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: 'forbidden' });
  });

  it('lets an allowed role through', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    t.memberships.set(USER_ID, {
      kind: 'member',
      membership: { workspaceId: WORKSPACE_A, role: 'admin', displayName: 'Ana' },
    });

    const response = await t.app.request('/v1/crm/admin', bearer(await mintToken({ key: t.es })));

    expect(response.status).toBe(200);
  });
});

describe('rate limiting (ST-32, C37, C38)', () => {
  it('limits reads to 120 per minute per user, with 429 and Retry-After', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    const token = await mintToken({ key: t.es });
    const otherToken = await mintToken({ key: t.es, claims: { sub: OTHER_USER_ID } });
    t.memberships.set(OTHER_USER_ID, {
      kind: 'member',
      membership: { workspaceId: WORKSPACE_A, role: 'viewer', displayName: 'Outra' },
    });

    for (let i = 0; i < STAFF_RATE_LIMITS.read.limit; i += 1) {
      expect((await t.app.request('/v1/crm/read', bearer(token))).status).toBe(200);
    }
    const limited = await t.app.request('/v1/crm/read', bearer(token));
    const otherUser = await t.app.request('/v1/crm/read', bearer(otherToken));

    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(await problem(limited)).toMatchObject({ code: 'rate_limited' });
    expect(otherUser.status).toBe(200);
  });

  it('keeps read and write buckets apart and limits writes to 30 per minute', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    const token = await mintToken({ key: t.es });

    for (let i = 0; i < STAFF_RATE_LIMITS.write.limit; i += 1) {
      expect((await t.app.request('/v1/crm/write', bearer(token))).status).toBe(200);
    }

    expect((await t.app.request('/v1/crm/write', bearer(token))).status).toBe(429);
    expect((await t.app.request('/v1/crm/read', bearer(token))).status).toBe(200);
  });

  it('resets the window as the clock advances', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    const token = await mintToken({ key: t.es });
    for (let i = 0; i < STAFF_RATE_LIMITS.write.limit; i += 1) {
      await t.app.request('/v1/crm/write', bearer(token));
    }
    expect((await t.app.request('/v1/crm/write', bearer(token))).status).toBe(429);

    t.clock.advance(61_000);
    const fresh = await mintToken({
      key: t.es,
      claims: { iat: AUTH_NOW_SECONDS + 55, exp: AUTH_NOW_SECONDS + 900 },
    });

    expect((await t.app.request('/v1/crm/write', bearer(fresh))).status).toBe(200);
  });

  it('partitions the key by bucket, workspace and user, and never puts an IP in clear', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });

    await t.app.request('/v1/crm/read', bearer(await mintToken({ key: t.es })));

    const keys = t.limiter.subjects;
    expect(keys).toContainEqual({ scope: 'read', subject: `${WORKSPACE_A}:${USER_ID}` });
    const ipKey = keys.find((entry) => entry.scope === 'ip');
    expect(ipKey?.subject).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keys)).not.toContain('203.0.113.9');
  });

  it('limits by IP before verifying the token', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    const ipLimit = STAFF_RATE_LIMITS.ip.limit;

    for (let i = 0; i < ipLimit; i += 1) {
      await t.app.request('/v1/crm/read', bearer('garbage.garbage.garbage'));
    }
    const flooded = await t.app.request('/v1/crm/read', bearer(await mintToken({ key: t.es })));

    expect(flooded.status).toBe(429);
    expect(flooded.headers.get('Retry-After')).not.toBeNull();
    expect(t.memberships.lookups).toHaveLength(0);
  });

  it('fails open on comfortable routes when the limiter backend is down, and records it', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    t.limiter.unavailable = true;

    const response = await t.app.request('/v1/crm/read', bearer(await mintToken({ key: t.es })));

    expect(response.status).toBe(200);
    expect(t.metrics.records.filter((r) => r.name === 'ratelimit.fail_open')).toEqual(
      expect.arrayContaining([
        { name: 'ratelimit.fail_open', value: 1, attributes: { scope: 'crm_read' } },
      ]),
    );
  });

  it('fails closed with 503 on export routes when the limiter backend is down', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    t.limiter.unavailable = true;
    t.memberships.set(USER_ID, {
      kind: 'member',
      membership: { workspaceId: WORKSPACE_A, role: 'admin', displayName: 'Ana' },
    });

    const response = await t.app.request('/v1/crm/export', bearer(await mintToken({ key: t.es })));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(await problem(response)).toMatchObject({ code: 'service_unavailable' });
  });

  it('limits exports to 5 per hour', async () => {
    const t = await buildStaffApp({ routes: routesWithBuckets });
    const token = await mintToken({ key: t.es });
    for (let i = 0; i < STAFF_RATE_LIMITS.export.limit; i += 1) {
      expect((await t.app.request('/v1/crm/export', bearer(token))).status).toBe(200);
    }

    const sixth = await t.app.request('/v1/crm/export', bearer(token));

    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('Retry-After')).toBe('3600');
  });

  it('refuses to rate limit a route that forgot authenticate (wiring bug fails closed)', async () => {
    const t: StaffApp = await buildStaffApp({
      routes: (guards) =>
        new Hono<StaffEnv>().get('/v1/crm/oops', guards.rateLimit('read', 'open'), (c) =>
          c.json({ ok: true }),
        ),
    });

    expect((await t.app.request('/v1/crm/oops')).status).toBe(401);
  });
});
