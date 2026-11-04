import { afterAll, describe, expect, it } from 'vitest';
import { HttpProblem } from '#/platform/errors/problem.ts';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { KEY_1, WORKSPACE_A, WORKSPACE_B } from '#test/fakes/crm-commands.ts';
import { buildCrmApp, type CrmApp } from '#test/crm-commands/crm-app.ts';
import { createContract } from '#test/contract/openapi.ts';

/**
 * Contract tests: real responses of the staff write and privacy routes (through `createApp`) are
 * validated against `contracts/openapi.v1.yaml` — status, media type, body schema, declared headers —
 * and the statuses observed per operation must be declared by the contract.
 */

const contract = createContract();

interface Scenario {
  readonly name: string;
  readonly path: string;
  readonly method: 'get' | 'post' | 'patch';
  readonly expectedStatus: number;
  readonly run: (t: CrmApp) => Promise<Response>;
}

const observed = new Map<string, Set<number>>();

/** Headers the contract lists on a response but only some of its statuses actually send. */
const OPTIONAL_HEADER_PROBLEM = /^declared header (Retry-After|WWW-Authenticate) is missing$/;

const STAGE = '/v1/crm/leads/{id}/stage';
const OWNER = '/v1/crm/leads/{id}/owner';
const NOTES = '/v1/crm/leads/{id}/notes';
const EXPORT = '/v1/crm/leads/export.csv';
const DATA_EXPORT = '/v1/crm/leads/{id}/data-export';
const ANONYMIZE = '/v1/crm/leads/{id}/anonymize';

const idOf = (t: CrmApp, overrides = {}) => t.harness.seed(WORKSPACE_A, overrides).id;
const stageBody = { to_stage: 'contacted', expected_version: 3 };

const scenarios: readonly Scenario[] = [
  // --- changeLeadStage
  {
    name: 'stage 200',
    path: STAGE,
    method: 'patch',
    expectedStatus: 200,
    run: (t) => t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, { body: stageBody }),
  },
  {
    name: 'stage 400 validation',
    path: STAGE,
    method: 'patch',
    expectedStatus: 400,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, {
        body: { to_stage: 'lost', expected_version: 3 },
      }),
  },
  {
    name: 'stage 400 invalid_json',
    path: STAGE,
    method: 'patch',
    expectedStatus: 400,
    run: (t) => t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, { body: '{bad' }),
  },
  {
    name: 'stage 401',
    path: STAGE,
    method: 'patch',
    expectedStatus: 401,
    run: (t) => {
      t.guards.principal = null;
      return t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, { body: stageBody });
    },
  },
  {
    name: 'stage 403 role',
    path: STAGE,
    method: 'patch',
    expectedStatus: 403,
    run: (t) => {
      t.as('viewer');
      return t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, { body: stageBody });
    },
  },
  {
    name: 'stage 404',
    path: STAGE,
    method: 'patch',
    expectedStatus: 404,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${t.harness.seed(WORKSPACE_B).id}/stage`, {
        body: stageBody,
      }),
  },
  {
    name: 'stage 409 version_conflict',
    path: STAGE,
    method: 'patch',
    expectedStatus: 409,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, {
        body: { to_stage: 'contacted', expected_version: 1 },
      }),
  },
  {
    name: 'stage 413',
    path: STAGE,
    method: 'patch',
    expectedStatus: 413,
    run: (t) => t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, { body: 'x'.repeat(17_000) }),
  },
  {
    name: 'stage 415',
    path: STAGE,
    method: 'patch',
    expectedStatus: 415,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, {
        headers: { 'Content-Type': 'text/plain' },
        body: 'x',
      }),
  },
  {
    name: 'stage 422',
    path: STAGE,
    method: 'patch',
    expectedStatus: 422,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, {
        body: { to_stage: 'won', expected_version: 3 },
      }),
  },
  {
    name: 'stage 429',
    path: STAGE,
    method: 'patch',
    expectedStatus: 429,
    run: (t) => {
      t.guards.limiterProblem = new HttpProblem(429, 'rate_limited', { retryAfterSeconds: 9 });
      return t.request('PATCH', `/v1/crm/leads/${idOf(t)}/stage`, { body: stageBody });
    },
  },
  {
    name: 'stage 500',
    path: STAGE,
    method: 'patch',
    expectedStatus: 500,
    run: (t) => {
      const id = idOf(t);
      t.harness.audit.append = () =>
        Promise.reject(new Error('relation "core.audit_log" broke at /srv/x.ts:1'));
      return t.request('PATCH', `/v1/crm/leads/${id}/stage`, { body: stageBody });
    },
  },
  {
    name: 'stage 503',
    path: STAGE,
    method: 'patch',
    expectedStatus: 503,
    run: (t) => {
      const id = idOf(t);
      t.harness.unitOfWork.failure = new DependencyUnavailableError('database');
      return t.request('PATCH', `/v1/crm/leads/${id}/stage`, { body: stageBody });
    },
  },
  // --- assignLeadOwner
  {
    name: 'owner 200',
    path: OWNER,
    method: 'patch',
    expectedStatus: 200,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${idOf(t)}/owner`, {
        body: { owner_user_id: null, expected_version: 3 },
      }),
  },
  {
    name: 'owner 400',
    path: OWNER,
    method: 'patch',
    expectedStatus: 400,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${idOf(t)}/owner`, { body: { expected_version: 3 } }),
  },
  {
    name: 'owner 403',
    path: OWNER,
    method: 'patch',
    expectedStatus: 403,
    run: (t) => {
      t.as('sales');
      return t.request('PATCH', `/v1/crm/leads/${idOf(t)}/owner`, {
        body: { owner_user_id: null, expected_version: 3 },
      });
    },
  },
  {
    name: 'owner 404',
    path: OWNER,
    method: 'patch',
    expectedStatus: 404,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${t.harness.seed(WORKSPACE_B).id}/owner`, {
        body: { owner_user_id: null, expected_version: 3 },
      }),
  },
  {
    name: 'owner 409',
    path: OWNER,
    method: 'patch',
    expectedStatus: 409,
    run: (t) =>
      t.request('PATCH', `/v1/crm/leads/${idOf(t)}/owner`, {
        body: { owner_user_id: null, expected_version: 9 },
      }),
  },
  // --- addLeadNote
  {
    name: 'notes 201',
    path: NOTES,
    method: 'post',
    expectedStatus: 201,
    run: (t) =>
      t.request('POST', `/v1/crm/leads/${idOf(t)}/notes`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { body: 'Ligar <b>amanhã</b>' },
      }),
  },
  {
    name: 'notes 400 key missing',
    path: NOTES,
    method: 'post',
    expectedStatus: 400,
    run: (t) => t.request('POST', `/v1/crm/leads/${idOf(t)}/notes`, { body: { body: 'x' } }),
  },
  {
    name: 'notes 403',
    path: NOTES,
    method: 'post',
    expectedStatus: 403,
    run: (t) => {
      t.as('viewer');
      return t.request('POST', `/v1/crm/leads/${idOf(t)}/notes`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { body: 'x' },
      });
    },
  },
  {
    name: 'notes 404',
    path: NOTES,
    method: 'post',
    expectedStatus: 404,
    run: (t) =>
      t.request('POST', `/v1/crm/leads/${t.harness.seed(WORKSPACE_B).id}/notes`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { body: 'x' },
      }),
  },
  {
    name: 'notes 409 anonymized',
    path: NOTES,
    method: 'post',
    expectedStatus: 409,
    run: (t) =>
      t.request(
        'POST',
        `/v1/crm/leads/${idOf(t, { anonymizedAt: new Date('2026-11-04T00:00:00Z') })}/notes`,
        { headers: { 'Idempotency-Key': KEY_1 }, body: { body: 'x' } },
      ),
  },
  {
    name: 'notes 422 key reused',
    path: NOTES,
    method: 'post',
    expectedStatus: 422,
    run: async (t) => {
      const id = idOf(t);
      await t.request('POST', `/v1/crm/leads/${id}/notes`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { body: 'a' },
      });
      return t.request('POST', `/v1/crm/leads/${id}/notes`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { body: 'b' },
      });
    },
  },
  {
    name: 'notes 503',
    path: NOTES,
    method: 'post',
    expectedStatus: 503,
    run: (t) => {
      t.harness.idempotency.unavailable = true;
      return t.request('POST', `/v1/crm/leads/${idOf(t)}/notes`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { body: 'x' },
      });
    },
  },
  // --- exportLeadsCsv
  {
    name: 'export 200',
    path: EXPORT,
    method: 'get',
    expectedStatus: 200,
    run: (t) => {
      idOf(t);
      return t.request('GET', '/v1/crm/leads/export.csv');
    },
  },
  {
    name: 'export 200 empty',
    path: EXPORT,
    method: 'get',
    expectedStatus: 200,
    run: (t) => t.request('GET', '/v1/crm/leads/export.csv'),
  },
  {
    name: 'export 400',
    path: EXPORT,
    method: 'get',
    expectedStatus: 400,
    run: (t) => t.request('GET', '/v1/crm/leads/export.csv?q=x'),
  },
  {
    name: 'export 403 forbidden',
    path: EXPORT,
    method: 'get',
    expectedStatus: 403,
    run: (t) => {
      t.as('sales');
      return t.request('GET', '/v1/crm/leads/export.csv');
    },
  },
  {
    name: 'export 403 mfa_required',
    path: EXPORT,
    method: 'get',
    expectedStatus: 403,
    run: (t) => {
      t.as('admin', { aal: 'aal1', mfaAgeSeconds: null });
      return t.request('GET', '/v1/crm/leads/export.csv');
    },
  },
  {
    name: 'export 429 in flight',
    path: EXPORT,
    method: 'get',
    expectedStatus: 429,
    run: async (t) => {
      await t.harness.exportLock.acquire(WORKSPACE_A, t.guards.principal!.userId);
      return t.request('GET', '/v1/crm/leads/export.csv');
    },
  },
  {
    name: 'export 503',
    path: EXPORT,
    method: 'get',
    expectedStatus: 503,
    run: (t) => {
      t.harness.exportLock.failure = new DependencyUnavailableError('cache');
      return t.request('GET', '/v1/crm/leads/export.csv');
    },
  },
  // --- exportLeadSubjectData
  {
    name: 'data-export 200',
    path: DATA_EXPORT,
    method: 'get',
    expectedStatus: 200,
    run: (t) => t.request('GET', `/v1/crm/leads/${idOf(t)}/data-export`),
  },
  {
    name: 'data-export 400',
    path: DATA_EXPORT,
    method: 'get',
    expectedStatus: 400,
    run: (t) => t.request('GET', '/v1/crm/leads/nope/data-export'),
  },
  {
    name: 'data-export 403',
    path: DATA_EXPORT,
    method: 'get',
    expectedStatus: 403,
    run: (t) => {
      t.as('admin', { aal: 'aal1', mfaAgeSeconds: null });
      return t.request('GET', `/v1/crm/leads/${idOf(t)}/data-export`);
    },
  },
  {
    name: 'data-export 404',
    path: DATA_EXPORT,
    method: 'get',
    expectedStatus: 404,
    run: (t) => t.request('GET', `/v1/crm/leads/${t.harness.seed(WORKSPACE_B).id}/data-export`),
  },
  {
    name: 'data-export 409',
    path: DATA_EXPORT,
    method: 'get',
    expectedStatus: 409,
    run: (t) =>
      t.request(
        'GET',
        `/v1/crm/leads/${idOf(t, { anonymizedAt: new Date('2026-11-04T00:00:00Z') })}/data-export`,
      ),
  },
  // --- anonymizeLead
  {
    name: 'anonymize 200 preview',
    path: ANONYMIZE,
    method: 'post',
    expectedStatus: 200,
    run: (t) => t.request('POST', `/v1/crm/leads/${idOf(t)}/anonymize`, { body: {} }),
  },
  {
    name: 'anonymize 200 applied',
    path: ANONYMIZE,
    method: 'post',
    expectedStatus: 200,
    run: async (t) => {
      const id = idOf(t);
      const preview = (await (
        await t.request('POST', `/v1/crm/leads/${id}/anonymize`, { body: {} })
      ).json()) as { plan_hash: string };
      return t.request('POST', `/v1/crm/leads/${id}/anonymize`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { confirm: true, plan_hash: preview.plan_hash },
      });
    },
  },
  {
    name: 'anonymize 400',
    path: ANONYMIZE,
    method: 'post',
    expectedStatus: 400,
    run: (t) =>
      t.request('POST', `/v1/crm/leads/${idOf(t)}/anonymize`, { body: { confirm: true } }),
  },
  {
    name: 'anonymize 403 reauth',
    path: ANONYMIZE,
    method: 'post',
    expectedStatus: 403,
    run: (t) => {
      t.as('admin', { mfaAgeSeconds: 900 });
      return t.request('POST', `/v1/crm/leads/${idOf(t)}/anonymize`, {
        body: { confirm: true, plan_hash: 'a'.repeat(43) },
      });
    },
  },
  {
    name: 'anonymize 404',
    path: ANONYMIZE,
    method: 'post',
    expectedStatus: 404,
    run: (t) =>
      t.request('POST', `/v1/crm/leads/${t.harness.seed(WORKSPACE_B).id}/anonymize`, { body: {} }),
  },
  {
    name: 'anonymize 409 plan_stale',
    path: ANONYMIZE,
    method: 'post',
    expectedStatus: 409,
    run: (t) =>
      t.request('POST', `/v1/crm/leads/${idOf(t)}/anonymize`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { confirm: true, plan_hash: 'a'.repeat(43) },
      }),
  },
  {
    name: 'anonymize 415',
    path: ANONYMIZE,
    method: 'post',
    expectedStatus: 415,
    run: (t) =>
      t.request('POST', `/v1/crm/leads/${idOf(t)}/anonymize`, {
        headers: { 'Content-Type': 'text/plain' },
        body: 'x',
      }),
  },
];

describe('crm write and privacy routes against contracts/openapi.v1.yaml', () => {
  it.each(scenarios)('$name conforms to the contract', async (scenario) => {
    // arrange
    const t = buildCrmApp();
    // act
    const response = await scenario.run(t);
    const bodyText = await response.text();
    const isCsv = (response.headers.get('Content-Type') ?? '').startsWith('text/csv');
    // assert
    expect(response.status).toBe(scenario.expectedStatus);
    const problems = contract
      .responseProblems(scenario.path, scenario.method, {
        status: response.status,
        headers: response.headers,
        bodyText,
      })
      .filter((problem) => !OPTIONAL_HEADER_PROBLEM.test(problem) || response.status === 429)
      // the helper parses every body as JSON; the CSV is validated by its media type and headers
      .filter((problem) => !(isCsv && problem === 'body is not valid JSON'));
    expect(problems).toEqual([]);
    const key = `${scenario.method} ${scenario.path}`;
    observed.set(key, (observed.get(key) ?? new Set<number>()).add(response.status));
  });

  afterAll(() => {
    // every observed status is declared by the contract for its operation
    for (const [key, statuses] of observed) {
      const [method, path] = key.split(' ') as [string, string];
      const declared = contract.declaredStatuses(path, method);
      for (const status of statuses) {
        expect(declared, `${key} → ${String(status)}`).toContain(status);
      }
    }
  });

  it('request fixtures are valid against the contract schemas', () => {
    expect(contract.requestProblems(STAGE, 'patch', stageBody)).toEqual([]);
    expect(
      contract.requestProblems(OWNER, 'patch', { owner_user_id: null, expected_version: 3 }),
    ).toEqual([]);
    expect(contract.requestProblems(NOTES, 'post', { body: 'x' })).toEqual([]);
    expect(contract.requestProblems(ANONYMIZE, 'post', {})).toEqual([]);
    expect(
      contract.requestProblems(ANONYMIZE, 'post', { confirm: true, plan_hash: 'a'.repeat(43) }),
    ).toEqual([]);
    // the contract itself rejects the mass-assignment shapes the routes reject
    expect(
      contract.requestProblems(STAGE, 'patch', { ...stageBody, owner_user_id: null }),
    ).not.toEqual([]);
    expect(contract.requestProblems(NOTES, 'post', { body: 'x', stage: 'won' })).not.toEqual([]);
  });

  it('documents the codes the routes emit', () => {
    expect(contract.documentedCodes(STAGE, 'patch', 409)).toEqual(
      expect.arrayContaining(['version_conflict', 'lead_anonymized', 'idempotency_in_progress']),
    );
    expect(contract.documentedCodes(STAGE, 'patch', 422)).toContain('invalid_stage_transition');
    expect(contract.documentedCodes(ANONYMIZE, 'post', 409)).toContain('plan_stale');
    expect(contract.documentedCodes(EXPORT, 'get', 403)).toEqual(
      expect.arrayContaining(['mfa_required', 'reauthentication_required']),
    );
  });
});
