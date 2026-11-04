import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STAFF_RATE_LIMITS } from '#/platform/auth/staff-rate-limiter.ts';
import {
  createGetStaffProfile,
  createListStaffMembers,
  type StaffDirectory,
  type StaffMemberRecord,
} from '#/modules/crm/application/staff-session.ts';
import { createCrmStaffRoutes } from '#/modules/crm/presentation/staff-routes.ts';
import {
  AUTH_NOW_SECONDS,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_A,
  mintToken,
} from '#test/fakes/staff-auth.ts';
import { bearer, buildStaffApp, type StaffApp } from '#test/fakes/staff-app.ts';
import { createContract, type Contract } from './openapi.ts';

/**
 * Contract tests for the `crm-session` operations: real responses (through `createApp`, the real guards over a
 * fake JWKS and in-memory fakes) are validated against `contracts/openapi.v1.yaml`, and the statuses observed
 * must equal the statuses the contract declares. Also pins the guard constants to the contract extensions.
 */

const ME = '/v1/crm/me';
const MEMBERS = '/v1/crm/members';
const EVERY_ROLE = ['owner', 'admin', 'sales', 'viewer'];
const MEMBER_ID = '0196f1a0-aaaa-4000-8000-0000000000aa' as StaffMemberRecord['userId'];

let contract: Contract;

beforeAll(() => {
  contract = createContract();
});

const records: readonly StaffMemberRecord[] = [
  { userId: USER_ID, displayName: 'Marina Souza', role: 'sales', active: true },
  { userId: MEMBER_ID, displayName: 'Paulo Antigo', role: 'viewer', active: false },
];

function directory(overrides: Partial<StaffDirectory> = {}): StaffDirectory {
  return {
    workspaceName: () => Promise.resolve('Empresa'),
    listMembers: () => Promise.resolve(records),
    ...overrides,
  };
}

async function buildApp(dir: StaffDirectory = directory()): Promise<StaffApp> {
  return buildStaffApp({
    routes: (guards) =>
      createCrmStaffRoutes({
        guards,
        getStaffProfile: createGetStaffProfile(dir),
        listStaffMembers: createListStaffMembers(dir),
      }),
  });
}

async function conforms(path: string, response: Response, expectedStatus: number): Promise<void> {
  const bodyText = await response.clone().text();
  expect(response.status).toBe(expectedStatus);
  expect(
    contract.responseProblems(path, 'get', {
      status: response.status,
      headers: response.headers,
      bodyText,
    }),
  ).toEqual([]);
}

interface Scenario {
  readonly name: string;
  readonly status: number;
  readonly run: (t: StaffApp) => Response | Promise<Response>;
  readonly dir?: StaffDirectory;
}

const scenarios = (path: string): readonly Scenario[] => [
  {
    name: 'authenticated member',
    status: 200,
    run: async (t) => t.app.request(path, bearer(await mintToken({ key: t.es }))),
  },
  {
    name: 'authenticated member with MFA',
    status: 200,
    run: async (t) =>
      t.app.request(
        path,
        bearer(
          await mintToken({
            key: t.es,
            claims: { aal: 'aal2', amr: [{ method: 'totp', timestamp: AUTH_NOW_SECONDS - 90 }] },
          }),
        ),
      ),
  },
  { name: 'no credential', status: 401, run: (t) => t.app.request(path) },
  {
    name: 'expired token',
    status: 401,
    run: async (t) =>
      t.app.request(
        path,
        bearer(await mintToken({ key: t.es, claims: { exp: AUTH_NOW_SECONDS - 60 } })),
      ),
  },
  {
    name: 'valid token without membership',
    status: 403,
    run: async (t) =>
      t.app.request(path, bearer(await mintToken({ key: t.es, claims: { sub: OTHER_USER_ID } }))),
  },
  {
    name: 'read quota exhausted',
    status: 429,
    run: async (t) => {
      const token = await mintToken({ key: t.es });
      let last = new Response();
      for (let i = 0; i <= STAFF_RATE_LIMITS.read.limit; i += 1) {
        last = await t.app.request(path, bearer(token));
      }
      return last;
    },
  },
  {
    name: 'unexpected failure',
    status: 500,
    dir: directory({
      workspaceName: () => Promise.reject(new Error('relation "core.workspaces" leaked')),
      listMembers: () => Promise.reject(new Error('relation "core.workspace_members" leaked')),
    }),
    run: async (t) => t.app.request(path, bearer(await mintToken({ key: t.es }))),
  },
  {
    name: 'identity provider keys unavailable',
    status: 503,
    run: async (t) => {
      t.endpoint.mode = 'down';
      return t.app.request(path, bearer(await mintToken({ key: t.es })));
    },
  },
];

describe.each([ME, MEMBERS])('GET %s conforms to the contract', (path) => {
  it('observes exactly the statuses the contract declares', async () => {
    const observed = new Set<number>();
    for (const scenario of scenarios(path)) {
      const t = await buildApp(scenario.dir);
      const response = await scenario.run(t);
      await conforms(path, response, scenario.status);
      observed.add(response.status);
    }
    expect([...observed].sort()).toEqual([...contract.declaredStatuses(path, 'get')].sort());
  });

  it('never leaks internals in the 500 body', async () => {
    const dir = directory({
      workspaceName: () => Promise.reject(new Error('relation "core.workspaces" leaked')),
      listMembers: () => Promise.reject(new Error('relation "core.workspace_members" leaked')),
    });
    const t = await buildApp(dir);

    const body = await (await t.app.request(path, bearer(await mintToken({ key: t.es })))).text();

    expect(body).not.toContain('core.workspace');
    expect(body).not.toContain('leaked');
  });
});

describe('GET /v1/crm/me payload', () => {
  it('shows the membership role, workspace and the MFA facts of the token', async () => {
    const t = await buildApp();
    const token = await mintToken({
      key: t.es,
      claims: {
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: AUTH_NOW_SECONDS - 90 }],
        app_metadata: { role: 'owner' },
      },
    });

    const response = await t.app.request(ME, bearer(token));

    expect(await response.json()).toEqual({
      user_id: USER_ID,
      email: 'vendedora@empresa.com.br',
      display_name: 'Marina Souza',
      role: 'sales',
      workspace: { id: WORKSPACE_A, name: 'Empresa' },
      aal: 'aal2',
      mfa_verified_at: new Date((AUTH_NOW_SECONDS - 90) * 1000).toISOString(),
    });
  });

  it('reports null mfa_verified_at for a password-only session', async () => {
    const t = await buildApp();
    const response = await t.app.request(ME, bearer(await mintToken({ key: t.es })));
    expect(await response.json()).toMatchObject({ aal: 'aal1', mfa_verified_at: null });
  });
});

describe('GET /v1/crm/members payload', () => {
  it('lists active and inactive members without e-mail', async () => {
    const t = await buildApp();

    const response = await t.app.request(MEMBERS, bearer(await mintToken({ key: t.es })));

    expect(await response.json()).toEqual({
      items: [
        { user_id: USER_ID, display_name: 'Marina Souza', role: 'sales', active: true },
        { user_id: MEMBER_ID, display_name: 'Paulo Antigo', role: 'viewer', active: false },
      ],
    });
  });

  it('asks the directory for the workspace of the membership, never one sent by the client', async () => {
    const asked: string[] = [];
    const t = await buildApp(
      directory({
        listMembers: (workspaceId) => {
          asked.push(workspaceId);
          return Promise.resolve([]);
        },
      }),
    );

    await t.app.request(
      `${MEMBERS}?workspace_id=0196f1a0-bbbb-7000-8000-00000000000b`,
      bearer(await mintToken({ key: t.es }), {
        'X-Workspace-Id': '0196f1a0-bbbb-7000-8000-00000000000b',
      }),
    );

    expect(asked).toEqual([WORKSPACE_A]);
  });
});

describe('guards match the contract extensions (ST-35, partial)', () => {
  const document = parse(
    readFileSync(new URL('../../../../contracts/openapi.v1.yaml', import.meta.url), 'utf8'),
  ) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };

  it.each([ME, MEMBERS])(
    '%s: x-roles lists every workspace role and security is staffBearer',
    (path) => {
      const operation = document.paths[path]?.get;
      expect(operation?.['x-roles']).toEqual(EVERY_ROLE);
      expect(operation?.security).toEqual([{ staffBearer: [] }]);
    },
  );

  it('STAFF_RATE_LIMITS equals every x-rate-limit declared under /v1/crm', () => {
    const declared: { bucket: string; limit: number; window_seconds: number }[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      if (!path.startsWith('/v1/crm/')) continue;
      for (const operation of Object.values(item)) {
        const limit = operation['x-rate-limit'] as (typeof declared)[number] | undefined;
        if (limit !== undefined) declared.push(limit);
      }
    }

    expect(declared.length).toBeGreaterThan(0);
    for (const { bucket, limit, window_seconds: windowSeconds } of declared) {
      const configured = STAFF_RATE_LIMITS[bucket as keyof typeof STAFF_RATE_LIMITS];
      expect({ bucket, limit, windowSeconds }).toEqual({
        bucket,
        limit: configured.limit,
        windowSeconds: configured.windowSeconds,
      });
    }
  });
});
