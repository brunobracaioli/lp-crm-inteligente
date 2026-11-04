import { beforeAll, describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { MAX_BODY_BYTES } from '#/platform/http-security/body-limit.ts';
import { err } from '#/shared/result.ts';
import type { SubmitLeadFailure } from '#/modules/lead-capture/application/submit-lead.ts';
import { buildLeadApp, validBody, type LeadApp } from '#test/lead-capture/lead-app.ts';
import { createContract } from './openapi.ts';

/**
 * Contract tests: real responses of `POST /v1/leads` (through `createApp`) are validated against
 * `contracts/openapi.v1.yaml` — status, media type, body schema and declared headers — and the
 * set of observed statuses must equal the set the contract declares.
 */

const PATH = '/v1/leads';
const METHOD = 'post';
const OTHER_KEY = '22222222-2222-4222-8222-222222222222';
const INTERNAL_DETAIL = 'relation "crm.leads" violates constraint at /srv/app/db.ts:42';

interface Scenario {
  readonly name: string;
  readonly expectedStatus: number;
  /** Fresh app per scenario; `build` may script the use case instead of the real one. */
  readonly build?: () => LeadApp;
  readonly run: (app: LeadApp) => Promise<Response>;
}

const refuse = (failure: SubmitLeadFailure) =>
  buildLeadApp({ submitLead: () => Promise.resolve(err(failure)) });

const scenarios: readonly Scenario[] = [
  { name: 'accepted new lead', expectedStatus: 202, run: (app) => app.post() },
  {
    name: 'replayed idempotent request',
    expectedStatus: 202,
    run: async (app) => {
      await app.post();
      return app.post({ body: validBody({ turnstile_token: '0.Another' }) });
    },
  },
  {
    name: 'honeypot hit',
    expectedStatus: 202,
    run: (app) => app.post({ body: validBody({ hp: 'bot' }) }),
  },
  {
    name: 'invalid_json',
    expectedStatus: 400,
    run: (app) => app.post({ body: '{"form_key":' }),
  },
  {
    name: 'validation_failed',
    expectedStatus: 400,
    run: (app) => app.post({ body: validBody({ stage: 'won', first_name: '<b>' }) }),
  },
  {
    name: 'idempotency_key_missing',
    expectedStatus: 400,
    run: (app) => app.post({ headers: { 'Idempotency-Key': null } }),
  },
  {
    name: 'origin_not_allowed',
    expectedStatus: 403,
    run: (app) => app.post({ headers: { Origin: 'https://evil.example' } }),
  },
  {
    name: 'bot_verification_failed',
    expectedStatus: 403,
    run: (app) => {
      app.harness.antiBot.outcome = { outcome: 'failed', reason: 'invalid_token' };
      return app.post();
    },
  },
  {
    name: 'form_not_found',
    expectedStatus: 404,
    run: (app) => app.post({ body: validBody({ form_key: 'frm_does_not_exist' }) }),
  },
  {
    name: 'idempotency_in_progress',
    expectedStatus: 409,
    build: () => refuse({ code: 'idempotency_in_progress', retryAfterSeconds: 1 }),
    run: (app) => app.post(),
  },
  {
    name: 'payload_too_large',
    expectedStatus: 413,
    run: (app) => app.post({ body: 'x'.repeat(MAX_BODY_BYTES + 1) }),
  },
  {
    name: 'unsupported_media_type',
    expectedStatus: 415,
    run: (app) => app.post({ headers: { 'Content-Type': 'text/plain' } }),
  },
  {
    name: 'idempotency_key_reused',
    expectedStatus: 422,
    run: async (app) => {
      await app.post();
      return app.post({ body: validBody({ first_name: 'Joana' }) });
    },
  },
  {
    name: 'rate_limited',
    expectedStatus: 429,
    run: (app) => {
      app.harness.rateLimiter.ip = { allowed: false, retryAfterSeconds: 120 };
      return app.post();
    },
  },
  {
    name: 'internal_error',
    expectedStatus: 500,
    run: (app) => {
      app.harness.outbox.failure = new Error(INTERNAL_DETAIL);
      return app.post({ headers: { 'Idempotency-Key': OTHER_KEY } });
    },
  },
  {
    name: 'service_unavailable (database down)',
    expectedStatus: 503,
    run: (app) => {
      app.harness.outbox.failure = new DependencyUnavailableError('database');
      return app.post();
    },
  },
  {
    name: 'bot_verification_unavailable',
    expectedStatus: 503,
    run: (app) => {
      app.harness.antiBot.outcome = { outcome: 'unavailable' };
      return app.post();
    },
  },
];

interface Observed {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

describe('POST /v1/leads against contracts/openapi.v1.yaml', () => {
  const contract = createContract();
  const observed = new Map<string, Observed>();

  beforeAll(async () => {
    for (const scenario of scenarios) {
      const response = await scenario.run((scenario.build ?? buildLeadApp)());
      observed.set(scenario.name, {
        status: response.status,
        headers: response.headers,
        bodyText: await response.text(),
      });
    }
  });

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    'response of "%s" conforms to the declared status, body and headers',
    (_name, scenario) => {
      // arrange
      const response = observed.get(scenario.name);
      expect(response).toBeDefined();
      if (response === undefined) return;

      // act
      const problems = contract.responseProblems(PATH, METHOD, response);

      // assert
      expect(response.status).toBe(scenario.expectedStatus);
      expect(problems).toEqual([]);
    },
  );

  it('every problem response carries a code the contract documents for that status', () => {
    for (const [name, response] of observed) {
      if (response.status === 202) continue;
      const { code } = JSON.parse(response.bodyText) as { code: string };
      expect(contract.documentedCodes(PATH, METHOD, response.status), name).toContain(code);
    }
  });

  it('problem bodies repeat the HTTP status and the X-Request-Id as correlation_id', () => {
    for (const [name, response] of observed) {
      if (response.status === 202) continue;
      const body = JSON.parse(response.bodyText) as { status: number; correlation_id: string };
      expect(body.status, name).toBe(response.status);
      expect(body.correlation_id, name).toBe(response.headers.get('X-Request-Id'));
    }
  });

  it('exercises exactly the statuses the contract declares (none missing, none undeclared)', () => {
    const seen = [...new Set([...observed.values()].map(({ status }) => status))].sort();
    const declared = [...contract.declaredStatuses(PATH, METHOD)].sort();
    expect(seen).toEqual(declared);
  });

  it('the valid request fixture conforms to the contract request schema', () => {
    expect(contract.requestProblems(PATH, METHOD, validBody())).toEqual([]);
  });

  describe('validator self-checks (it must be able to fail)', () => {
    const headers = (entries: Record<string, string>) => new Headers(entries);

    it('rejects an undeclared status', () => {
      const problems = contract.responseProblems(PATH, METHOD, {
        status: 418,
        headers: headers({ 'Content-Type': 'application/problem+json' }),
        bodyText: '{}',
      });
      expect(problems.join()).toContain('not declared');
    });

    it('rejects a 202 body with a missing or extra property', () => {
      const base = { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() };
      const missing = contract.responseProblems(PATH, METHOD, {
        status: 202,
        headers: headers(base),
        bodyText: '{"status":"received"}',
      });
      const extra = contract.responseProblems(PATH, METHOD, {
        status: 202,
        headers: headers(base),
        bodyText: JSON.stringify({
          status: 'received',
          submission_id: crypto.randomUUID(),
          event_id: crypto.randomUUID(),
          lead_id: crypto.randomUUID(),
        }),
      });
      expect(missing).not.toEqual([]);
      expect(extra).not.toEqual([]);
    });

    it('rejects a 429 without Retry-After and a Retry-After that is not a positive integer', () => {
      const problem = JSON.stringify({
        type: 'https://api.test/problems/rate_limited',
        title: 'Too many requests',
        status: 429,
        code: 'rate_limited',
        correlation_id: crypto.randomUUID(),
      });
      const base = { 'Content-Type': 'application/problem+json' };
      const absent = contract.responseProblems(PATH, METHOD, {
        status: 429,
        headers: headers(base),
        bodyText: problem,
      });
      const zero = contract.responseProblems(PATH, METHOD, {
        status: 429,
        headers: headers({ ...base, 'Retry-After': '0' }),
        bodyText: problem,
      });
      expect(absent.join()).toContain('Retry-After');
      expect(zero.join()).toContain('Retry-After');
    });

    it('rejects a problem with an unknown code or a wrong media type', () => {
      const bodyText = JSON.stringify({
        type: 'https://api.test/problems/x',
        title: 'x',
        status: 500,
        code: 'made_up_code',
        correlation_id: crypto.randomUUID(),
      });
      const wrongMedia = contract.responseProblems(PATH, METHOD, {
        status: 500,
        headers: headers({ 'Content-Type': 'application/json' }),
        bodyText,
      });
      const unknownCode = contract.responseProblems(PATH, METHOD, {
        status: 500,
        headers: headers({ 'Content-Type': 'application/problem+json' }),
        bodyText,
      });
      expect(wrongMedia.join()).toContain('media type');
      expect(unknownCode.join()).toContain('/code');
    });
  });
});
