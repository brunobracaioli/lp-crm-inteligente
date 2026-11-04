import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import type { ActivityView, SubmissionView } from '#/modules/crm/application/queries/ports.ts';
import { CRM_READ_ROLES } from '#/modules/crm/presentation/read-routes.ts';
import { NO_TOUCH, USER_A, WORKSPACE_A, WORKSPACE_B, aProfile } from '#test/fakes/crm-read.ts';
import {
  LIST_PATH,
  SEARCH_PATH,
  aPrincipal,
  buildReadApp,
  detailPath,
  type ReadApp,
} from '#test/crm/read-app.ts';
import { createContract } from './openapi.ts';

/**
 * Contract tests of the CRM read operations (wave 9b): real responses of `listLeads`,
 * `searchLeads` and `getLead` (through `createApp`) validated against `contracts/openapi.v1.yaml` —
 * status, media type, body schema and declared headers — plus drift checks between the contract
 * (`security`, `x-roles`, `x-rate-limit`) and the routes (threat model ST-35).
 */

const contract = createContract();
const T0 = new Date('2026-11-03T14:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const uuid = (prefix: string, n: number): string =>
  `0194f1c2-${prefix}-7000-8000-${n.toString().padStart(12, '0')}`;
const LEAD_ID = uuid('aaaa', 1);
const FOREIGN_LEAD_ID = uuid('dddd', 1);

const OPERATIONS = [
  { operationId: 'listLeads', method: 'get', path: '/v1/crm/leads' },
  { operationId: 'searchLeads', method: 'post', path: '/v1/crm/leads/search' },
  { operationId: 'getLead', method: 'get', path: '/v1/crm/leads/{id}' },
] as const;

const FULL_TOUCH = {
  utmSource: 'meta',
  utmMedium: 'cpc',
  utmCampaign: 'black-friday',
  utmTerm: 'crm',
  utmContent: 'video-1',
  utmId: '123',
  landingPageUrl: 'https://www.dominio.com.br/?utm_source=meta',
  referrerUrl: 'https://l.facebook.com/',
  clickIdTypes: ['gclid', 'fbclid'],
} as const;

function submission(n: number): SubmissionView {
  return {
    id: uuid('cccc', n),
    createdAt: at(-n),
    fields: {
      firstName: 'Carla',
      lastName: 'Menezes',
      email: 'carla@acme.com.br',
      whatsapp: '+5511912345678',
      company: 'Acme Ltda',
      areaOfExpertise: 'other',
      areaOfExpertiseOther: 'Gestão de frotas',
      jobTitle: 'Diretora',
      companySize: '51_200',
      companyWebsite: 'https://acme.com.br',
      marketingOptIn: true,
    },
    message: '<img src=x onerror=alert(1)> quero uma demo',
    attribution: FULL_TOUCH,
    consentState: {
      analyticsStorage: 'granted',
      adStorage: 'denied',
      adUserData: 'denied',
      adPersonalization: 'granted',
    },
  };
}

const ACTIVITIES: readonly ActivityView[] = [
  { type: 'submission_received', data: { submission_id: uuid('cccc', 1) }, actorType: 'system' },
  {
    type: 'stage_changed',
    data: { from_stage: 'new', to_stage: 'lost', lost_reason: 'timing' },
    actorType: 'user',
  },
  {
    type: 'owner_assigned',
    data: { from_owner_user_id: null, to_owner_user_id: USER_A },
    actorType: 'user',
  },
  { type: 'note_added', data: { body: '<b>ligar</b> amanhã' }, actorType: 'user' },
  {
    type: 'score_changed',
    data: { from_score: 40, to_score: 72, from_band: 'B', to_band: 'A' },
    actorType: 'system',
  },
  { type: 'insight_generated', data: { insight_id: uuid('9999', 1) }, actorType: 'ai' },
  { type: 'conversion_sent', data: { destination: 'meta_capi' }, actorType: 'system' },
  { type: 'anonymized', data: {}, actorType: 'user' },
].map((partial, index): ActivityView => ({
  id: uuid('bbbb', index + 1),
  type: partial.type as ActivityView['type'],
  actorType: partial.actorType as ActivityView['actorType'],
  actorId: partial.actorType === 'user' ? USER_A : null,
  createdAt: at(index),
  data: partial.data,
}));

function seed(harness: ReadApp): void {
  const queries = harness.queries;
  queries.addLead(
    WORKSPACE_A,
    aProfile(LEAD_ID, at(0), {
      companySize: null,
      jobTitle: null,
      stage: 'lost',
      lostReason: 'timing',
      ownerUserId: USER_A,
      anonymizedAt: at(100),
      areaOfExpertise: 'other',
      areaOfExpertiseOther: 'Gestão de frotas',
      scoreBreakdown: [],
    }),
    {
      firstTouch: FULL_TOUCH,
      lastTouch: NO_TOUCH,
      submissions: [submission(1), submission(2)],
      consents: [
        {
          purpose: 'privacy_policy',
          granted: true,
          policyVersion: '2026-11-03',
          recordedAt: at(0),
        },
        {
          purpose: 'marketing_communications',
          granted: false,
          policyVersion: '2026-11-03.1',
          recordedAt: at(1),
        },
        { purpose: 'ad_tracking', granted: true, policyVersion: '2026-11-03', recordedAt: at(2) },
      ],
      activities: ACTIVITIES,
    },
  );
  for (let n = 2; n <= 30; n += 1) {
    queries.addLead(WORKSPACE_A, aProfile(uuid('aaaa', n), at(-n * 10)));
  }
  queries.addLead(WORKSPACE_B, aProfile(FOREIGN_LEAD_ID, at(5)));
}

interface Scenario {
  readonly operation: (typeof OPERATIONS)[number];
  readonly name: string;
  readonly expectedStatus: number;
  readonly run: (harness: ReadApp) => Promise<Response>;
}

const scenarios: readonly Scenario[] = [
  // listLeads
  {
    operation: OPERATIONS[0],
    name: 'first page',
    expectedStatus: 200,
    run: (h) => h.get(LIST_PATH),
  },
  {
    operation: OPERATIONS[0],
    name: 'filtered, last page',
    expectedStatus: 200,
    run: (h) => h.get(`${LIST_PATH}?stage=lost&owner=me&score_band=A&limit=100`),
  },
  {
    operation: OPERATIONS[0],
    name: 'empty result',
    expectedStatus: 200,
    run: (h) => h.get(`${LIST_PATH}?stage=won`),
  },
  {
    operation: OPERATIONS[0],
    name: 'unknown parameter',
    expectedStatus: 400,
    run: (h) => h.get(`${LIST_PATH}?q=ana`),
  },
  {
    operation: OPERATIONS[0],
    name: 'limit out of range',
    expectedStatus: 400,
    run: (h) => h.get(`${LIST_PATH}?limit=101`),
  },
  {
    operation: OPERATIONS[0],
    name: 'forged cursor',
    expectedStatus: 400,
    run: (h) => h.get(`${LIST_PATH}?cursor=abc.def`),
  },
  {
    operation: OPERATIONS[0],
    name: 'role outside the allowlist',
    expectedStatus: 403,
    run: (h) => {
      h.setPrincipal(aPrincipal({ role: 'guest' as never }));
      return h.get(LIST_PATH);
    },
  },
  {
    operation: OPERATIONS[0],
    name: 'database down',
    expectedStatus: 503,
    run: (h) => {
      h.unitOfWork.failure = new DependencyUnavailableError('database');
      return h.get(LIST_PATH);
    },
  },
  {
    operation: OPERATIONS[0],
    name: 'unexpected failure',
    expectedStatus: 500,
    run: (h) => {
      h.unitOfWork.failure = new Error('relation "crm.leads" does not exist');
      return h.get(LIST_PATH);
    },
  },
  // searchLeads
  {
    operation: OPERATIONS[1],
    name: 'prefix search',
    expectedStatus: 200,
    run: (h) => h.post(SEARCH_PATH, { q: 'ca', limit: 5 }),
  },
  {
    operation: OPERATIONS[1],
    name: 'no match',
    expectedStatus: 200,
    run: (h) => h.post(SEARCH_PATH, { q: 'zzz', stage: 'new' }),
  },
  {
    operation: OPERATIONS[1],
    name: 'term too short',
    expectedStatus: 400,
    run: (h) => h.post(SEARCH_PATH, { q: 'a' }),
  },
  {
    operation: OPERATIONS[1],
    name: 'extra field',
    expectedStatus: 400,
    run: (h) => h.post(SEARCH_PATH, { q: 'ca', workspace_id: WORKSPACE_B }),
  },
  {
    operation: OPERATIONS[1],
    name: 'invalid JSON',
    expectedStatus: 400,
    run: (h) => h.post(SEARCH_PATH, '{"q":'),
  },
  {
    operation: OPERATIONS[1],
    name: 'role outside the allowlist',
    expectedStatus: 403,
    run: (h) => {
      h.setPrincipal(aPrincipal({ role: 'guest' as never }));
      return h.post(SEARCH_PATH, { q: 'ca' });
    },
  },
  {
    operation: OPERATIONS[1],
    name: 'body above 16 KB',
    expectedStatus: 413,
    run: (h) => h.post(SEARCH_PATH, { q: 'a'.repeat(20_000) }),
  },
  {
    operation: OPERATIONS[1],
    name: 'not JSON',
    expectedStatus: 415,
    run: (h) =>
      h.post(SEARCH_PATH, 'q=ca', { 'Content-Type': 'application/x-www-form-urlencoded' }),
  },
  {
    operation: OPERATIONS[1],
    name: 'database down',
    expectedStatus: 503,
    run: (h) => {
      h.unitOfWork.failure = new DependencyUnavailableError('database');
      return h.post(SEARCH_PATH, { q: 'ca' });
    },
  },
  {
    operation: OPERATIONS[1],
    name: 'unexpected failure',
    expectedStatus: 500,
    run: (h) => {
      h.unitOfWork.failure = new Error('relation "crm.leads" does not exist');
      return h.post(SEARCH_PATH, { q: 'ca' });
    },
  },
  // getLead
  {
    operation: OPERATIONS[2],
    name: 'full detail',
    expectedStatus: 200,
    run: (h) => h.get(detailPath(LEAD_ID)),
  },
  {
    operation: OPERATIONS[2],
    name: 'first page of a long timeline',
    expectedStatus: 200,
    run: (h) => h.get(`${detailPath(LEAD_ID)}?activities_limit=3`),
  },
  {
    operation: OPERATIONS[2],
    name: 'lead without history',
    expectedStatus: 200,
    run: (h) => h.get(detailPath(uuid('aaaa', 2))),
  },
  {
    operation: OPERATIONS[2],
    name: 'invalid id',
    expectedStatus: 400,
    run: (h) => h.get(detailPath('not-a-uuid')),
  },
  {
    operation: OPERATIONS[2],
    name: 'invalid activities limit',
    expectedStatus: 400,
    run: (h) => h.get(`${detailPath(LEAD_ID)}?activities_limit=0`),
  },
  {
    operation: OPERATIONS[2],
    name: 'foreign workspace',
    expectedStatus: 404,
    run: (h) => h.get(detailPath(FOREIGN_LEAD_ID)),
  },
  {
    operation: OPERATIONS[2],
    name: 'nonexistent',
    expectedStatus: 404,
    run: (h) => h.get(detailPath(uuid('eeee', 1))),
  },
  {
    operation: OPERATIONS[2],
    name: 'role outside the allowlist',
    expectedStatus: 403,
    run: (h) => {
      h.setPrincipal(aPrincipal({ role: 'guest' as never }));
      return h.get(detailPath(LEAD_ID));
    },
  },
  {
    operation: OPERATIONS[2],
    name: 'database down',
    expectedStatus: 503,
    run: (h) => {
      h.unitOfWork.failure = new DependencyUnavailableError('database');
      return h.get(detailPath(LEAD_ID));
    },
  },
  {
    operation: OPERATIONS[2],
    name: 'unexpected failure',
    expectedStatus: 500,
    run: (h) => {
      h.unitOfWork.failure = new Error('relation "crm.leads" does not exist');
      return h.get(detailPath(LEAD_ID));
    },
  },
];

describe('CRM read responses conform to the OpenAPI contract', () => {
  it.each(scenarios)('$operation.operationId: $name → $expectedStatus', async (scenario) => {
    const harness = buildReadApp();
    seed(harness);

    const response = await scenario.run(harness);
    const bodyText = await response.text();

    expect(response.status).toBe(scenario.expectedStatus);
    expect(
      contract.responseProblems(scenario.operation.path, scenario.operation.method, {
        status: response.status,
        headers: response.headers,
        bodyText,
      }),
    ).toEqual([]);
  });

  it.each(OPERATIONS)('$operationId: every status the routes emit is declared', (operation) => {
    const observed = new Set(
      scenarios.filter((s) => s.operation === operation).map((s) => s.expectedStatus),
    );
    const declared = new Set(contract.declaredStatuses(operation.path, operation.method));

    expect([...observed].filter((status) => !declared.has(status))).toEqual([]);
    // 401 and 429 come from the guards (staff authenticator, rate limiter), covered by their own suites.
    expect([...declared].filter((s) => !observed.has(s) && ![401, 429].includes(s))).toEqual([]);
  });

  it('serves the detail with the cross-checked invariants of the contract description', async () => {
    const harness = buildReadApp();
    seed(harness);

    const body = (await (await harness.get(detailPath(LEAD_ID))).json()) as {
      lead: Record<string, unknown>;
      submissions: { attribution: Record<string, unknown> }[];
      consents: unknown[];
      activities: { items: unknown[] };
    };
    const serialized = JSON.stringify(body);

    expect(body.consents).toHaveLength(3);
    expect(body.activities.items).toHaveLength(ACTIVITIES.length);
    for (const forbidden of ['client_ip', 'user_agent', 'ip_hmac', 'fbp', 'fbc', 'ga_client_id']) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(body.submissions[0]?.attribution.click_id_types).toEqual(['gclid', 'fbclid']);
  });
});

describe('CRM read routes match the contract operations (drift)', () => {
  const document = parse(
    readFileSync(new URL('../../../../contracts/openapi.v1.yaml', import.meta.url), 'utf8'),
  ) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };

  it.each(OPERATIONS)('$operationId is registered with the same method and path', (operation) => {
    const harness = buildReadApp();
    const honoPath = operation.path.replace('{id}', ':id{[^.]+}');

    const registered = harness.routes.routes.some(
      (route) => route.method === operation.method.toUpperCase() && route.path === honoPath,
    );

    expect(registered).toBe(true);
  });

  it('registers no CRM read route that the contract does not declare', () => {
    const harness = buildReadApp();
    const declared = new Set(
      OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.path.replace('{id}', ':id{[^.]+}')}`),
    );

    const registered = harness.routes.routes.map((route) => `${route.method} ${route.path}`);

    expect(registered.filter((route) => !declared.has(route))).toEqual([]);
  });

  it.each(OPERATIONS)(
    '$operationId requires staffBearer and the roles the middleware enforces',
    (operation) => {
      const declared = document.paths[operation.path]?.[operation.method];

      expect(declared?.operationId).toBe(operation.operationId);
      expect(declared?.security).toEqual([{ staffBearer: [] }]);
      expect([...(declared?.['x-roles'] as string[])].sort()).toEqual([...CRM_READ_ROLES].sort());
    },
  );

  it.each(OPERATIONS)(
    '$operationId declares the read bucket, fail-open, which the routes request',
    (operation) => {
      const declared = document.paths[operation.path]?.[operation.method];
      const harness = buildReadApp();

      expect(declared?.['x-rate-limit']).toMatchObject({ bucket: 'read', fail: 'open' });
      expect(harness.rateLimits).toEqual([{ bucket: 'read', fail: 'open' }]);
    },
  );
});
