import { describe, expect, it, vi } from 'vitest';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { MAX_BODY_BYTES } from '#/platform/http-security/body-limit.ts';
import { SECURITY_HEADERS } from '#/platform/http-security/security-headers.ts';
import type { EventId, SubmissionId } from '#/shared/ids.ts';
import { err, ok } from '#/shared/result.ts';
import type {
  SubmitLead,
  SubmitLeadFailure,
  SubmitLeadResult,
} from '#/modules/lead-capture/application/submit-lead.ts';
import { BOT_VERIFICATION_UNAVAILABLE_RETRY_AFTER_SECONDS } from '#/modules/lead-capture/presentation/failure-mapping.ts';
import { CLIENT_EVENT_ID } from '#test/fakes/submit-lead-harness.ts';
import {
  buildLeadApp,
  CLIENT_IP,
  IDEMPOTENCY_KEY,
  LEADS_PATH,
  UUID_PATTERN,
  validBody,
  type LeadApp,
} from './lead-app.ts';

const SECOND_KEY = '22222222-2222-4222-8222-222222222222';
const THIRD_KEY = '33333333-3333-4333-8333-333333333333';
const SECOND_EVENT_ID = '6c2e8e3f-0b45-4d7c-9f21-2b3c4d5e6f70';
const THIRD_EVENT_ID = '7d3f9f40-1c56-4e8d-8a32-3c4d5e6f7081';
const INTERNAL_DETAIL = 'relation "crm.leads" violates constraint at /srv/app/db.ts:42';
const INPUT_MARKER = 'SECRET-INPUT-MARKER-9f3a';
const FIXED_SUBMISSION_ID = '00000000-0000-7000-8000-0000000000aa' as SubmissionId;
const FIXED_EVENT_ID = '00000000-0000-7000-8000-0000000000bb' as EventId;

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

/** A `SubmitLead` that records its command and returns a scripted result. */
function scripted(result: SubmitLeadResult) {
  const submitLead = vi.fn<SubmitLead>(() => Promise.resolve(result));
  return { submitLead, ...buildLeadApp({ submitLead }) };
}

const acceptedResult: SubmitLeadResult = ok({
  accepted: { submissionId: FIXED_SUBMISSION_ID, eventId: FIXED_EVENT_ID },
  outcome: 'accepted',
});

/** The accepted-path expectations shared by AC-LC-01/04 style checks. */
async function expectAcceptedShape(response: Response): Promise<Record<string, unknown>> {
  const body = await json(response);
  expect(response.status).toBe(202);
  expect(Object.keys(body).sort()).toEqual(['event_id', 'status', 'submission_id']);
  expect(body.status).toBe('received');
  expect(body.submission_id).toMatch(UUID_PATTERN);
  expect(body.event_id).toMatch(UUID_PATTERN);
  return body;
}

describe('POST /v1/leads — accepted', () => {
  it('AC-LC-01 returns 202 {status, submission_id, event_id} and persists one submission', async () => {
    // arrange
    const { post, harness } = buildLeadApp();

    // act
    const response = await post();

    // assert
    const body = await expectAcceptedShape(response);
    expect(body.event_id).toBe(CLIENT_EVENT_ID);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('X-Request-Id')).toMatch(UUID_PATTERN);
    expect(harness.persistedRows()).toMatchObject({ leads: 1, submissions: 1, consents: 3 });
  });

  it('AC-LC-16 sends the 8 security headers on the 202', async () => {
    const { post } = buildLeadApp();

    const response = await post();

    expect(Object.keys(SECURITY_HEADERS)).toHaveLength(8);
    expectSecurityHeaders(response);
  });

  it('accepts a charset=UTF-8 parameter on the content type', async () => {
    const { post } = buildLeadApp();

    const response = await post({ headers: { 'Content-Type': 'application/json; charset=UTF-8' } });

    expect(response.status).toBe(202);
  });

  it('hands the use case the parsed body, origin, key, IP, user agent and correlation id', async () => {
    // arrange
    const correlationId = '6a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    const { post, submitLead } = scripted(acceptedResult);

    // act
    await post({ headers: { 'X-Request-Id': correlationId, 'Idempotency-Key': SECOND_KEY } });

    // assert
    expect(submitLead).toHaveBeenCalledOnce();
    expect(submitLead.mock.calls[0]?.[0]).toEqual({
      body: validBody(),
      origin: 'https://www.dominio.com.br',
      idempotencyKey: SECOND_KEY,
      clientIp: CLIENT_IP,
      userAgent: 'TestBrowser/1.0',
      correlationId,
    });
  });

  it('lowercases the Idempotency-Key so A… and a… are one intent', async () => {
    const { post, submitLead } = scripted(acceptedResult);

    await post({ headers: { 'Idempotency-Key': SECOND_KEY.toUpperCase() } });

    expect(submitLead.mock.calls[0]?.[0].idempotencyKey).toBe(SECOND_KEY);
  });

  it('leaves the client IP unknown outside Vercel and never trusts X-Forwarded-For', async () => {
    // arrange
    const { post, submitLead } = scripted(acceptedResult);
    const local = buildLeadApp({ trustVercelProxy: false, submitLead });

    // act
    await local.post({ headers: { 'X-Forwarded-For': '198.51.100.99' } });
    await post({ headers: { 'X-Real-IP': null, 'X-Forwarded-For': '198.51.100.99' } });

    // assert
    expect(submitLead.mock.calls.map(([command]) => command.clientIp)).toEqual([null, null]);
  });
});

describe('POST /v1/leads — SubmitLeadFailure mapping', () => {
  const cases: readonly {
    readonly failure: SubmitLeadFailure;
    readonly status: number;
    readonly code: string;
    readonly retryAfter: string | null;
  }[] = [
    {
      failure: { code: 'rate_limited', scope: 'ip', retryAfterSeconds: 42 },
      status: 429,
      code: 'rate_limited',
      retryAfter: '42',
    },
    {
      failure: { code: 'rate_limited', scope: 'form', retryAfterSeconds: 0.2 },
      status: 429,
      code: 'rate_limited',
      retryAfter: '1',
    },
    {
      failure: { code: 'rate_limited', scope: 'email', retryAfterSeconds: 3600 },
      status: 429,
      code: 'rate_limited',
      retryAfter: '3600',
    },
    {
      failure: { code: 'validation_failed', errors: [{ field: 'email', code: 'required' }] },
      status: 400,
      code: 'validation_failed',
      retryAfter: null,
    },
    { failure: { code: 'form_not_found' }, status: 404, code: 'form_not_found', retryAfter: null },
    {
      failure: { code: 'origin_not_allowed' },
      status: 403,
      code: 'origin_not_allowed',
      retryAfter: null,
    },
    {
      failure: { code: 'bot_verification_failed', reason: 'token_reused' },
      status: 403,
      code: 'bot_verification_failed',
      retryAfter: null,
    },
    {
      failure: { code: 'bot_verification_unavailable' },
      status: 503,
      code: 'bot_verification_unavailable',
      retryAfter: String(BOT_VERIFICATION_UNAVAILABLE_RETRY_AFTER_SECONDS),
    },
    {
      failure: { code: 'idempotency_in_progress', retryAfterSeconds: 1 },
      status: 409,
      code: 'idempotency_in_progress',
      retryAfter: '1',
    },
    {
      failure: { code: 'idempotency_key_reused' },
      status: 422,
      code: 'idempotency_key_reused',
      retryAfter: null,
    },
  ];

  it.each(cases)(
    '$failure.code → $status $code, Retry-After $retryAfter',
    async ({ failure, status, code, retryAfter }) => {
      // arrange
      const { post } = scripted(err(failure));

      // act
      const response = await post();

      // assert
      const body = await json(response);
      expect(response.status).toBe(status);
      expect(response.headers.get('Content-Type')).toBe('application/problem+json');
      expect(response.headers.get('Retry-After')).toBe(retryAfter);
      expect(body).toMatchObject({ status, code });
      expect(body.correlation_id).toBe(response.headers.get('X-Request-Id'));
      expectSecurityHeaders(response);
    },
  );

  it('maps every failure code of the use case (exhaustive table)', () => {
    const covered = new Set(cases.map(({ failure }) => failure.code));
    const all: Record<SubmitLeadFailure['code'], true> = {
      rate_limited: true,
      validation_failed: true,
      form_not_found: true,
      origin_not_allowed: true,
      bot_verification_failed: true,
      bot_verification_unavailable: true,
      idempotency_in_progress: true,
      idempotency_key_reused: true,
    };
    expect([...covered].sort()).toEqual(Object.keys(all).sort());
  });

  it('never leaks the bot_verification_failed reason to the client', async () => {
    // arrange
    const { post, logLines } = scripted(
      err({ code: 'bot_verification_failed', reason: 'hostname_mismatch' }),
    );

    // act
    const response = await post();

    // assert
    const text = await response.text();
    expect(text).not.toContain('hostname_mismatch');
    expect(text).not.toContain('reason');
    expect(logLines.join('')).toContain('hostname_mismatch');
  });

  it('passes field errors through with the stable codes and no received values', async () => {
    const errors = [
      { field: 'whatsapp', code: 'invalid_format' },
      { field: 'tracking.fbp', code: 'invalid_format' },
    ] as const;
    const { post } = scripted(err({ code: 'validation_failed', errors }));

    const response = await post();

    expect((await json(response)).errors).toEqual(errors);
  });
});

describe('POST /v1/leads — transport guards', () => {
  it.each([
    ['absent', null],
    ['not a UUID', 'not-a-uuid'],
    ['a UUID v1', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
    ['empty', ''],
    ['two keys joined', `${IDEMPOTENCY_KEY}, ${SECOND_KEY}`],
  ])('AC-LC-12 Idempotency-Key %s → 400 idempotency_key_missing', async (_label, value) => {
    // arrange
    const { post, submitLead } = scripted(acceptedResult);

    // act
    const response = await post({ headers: { 'Idempotency-Key': value } });

    // assert
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ code: 'idempotency_key_missing' });
    expect(submitLead).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['absent', null],
    ['a non-UTF-8 charset', 'application/json; charset=latin1'],
    ['an extra parameter', 'application/json; boundary=x'],
    ['a look-alike type', 'application/jsonp'],
    ['form encoding', 'application/x-www-form-urlencoded'],
  ])('AC-LC-12 Content-Type %s → 415 unsupported_media_type', async (_label, value) => {
    const { post, submitLead } = scripted(acceptedResult);

    const response = await post({ headers: { 'Content-Type': value } });

    expect(response.status).toBe(415);
    expect(await json(response)).toMatchObject({ code: 'unsupported_media_type' });
    expect(submitLead).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it('AC-LC-12 body above 16 KB → 413 payload_too_large before the use case runs', async () => {
    const { post, submitLead } = scripted(acceptedResult);

    const response = await post({ body: 'x'.repeat(MAX_BODY_BYTES + 1) });

    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({ code: 'payload_too_large' });
    expect(submitLead).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it.each([
    ['truncated JSON', `{"form_key": "${INPUT_MARKER}`],
    ['empty body', ''],
    ['plain text', INPUT_MARKER],
    ['trailing garbage', `{"a":1} ${INPUT_MARKER}`],
  ])('%s → 400 invalid_json without echoing the input', async (_label, body) => {
    const { post, submitLead } = scripted(acceptedResult);

    const response = await post({ body });

    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ code: 'invalid_json' });
    expect(text).not.toContain(INPUT_MARKER);
    expect(submitLead).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it.each([['[]'], ['"text"'], ['42'], ['null']])(
    'non-object JSON %s reaches the use case and gets validation_failed',
    async (body) => {
      const { post } = buildLeadApp();

      const response = await post({ body });

      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({ code: 'validation_failed' });
    },
  );

  it('other methods on the route get the generic 404 problem with security headers', async () => {
    const { app } = buildLeadApp();

    const response = await app.request(LEADS_PATH, { method: 'GET' });

    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({ code: 'not_found' });
    expectSecurityHeaders(response);
  });
});

describe('POST /v1/leads — CORS and Origin', () => {
  it('AC-LC-07 preflight from the allowed origin gets ACAO, no credentials and security headers', async () => {
    const { preflight } = buildLeadApp();

    const response = await preflight('https://www.dominio.com.br');

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.dominio.com.br');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Idempotency-Key');
    expectSecurityHeaders(response);
  });

  it('AC-LC-07 preflight from a denied origin gets no Access-Control-Allow-Origin', async () => {
    const { preflight } = buildLeadApp();

    const response = await preflight('https://evil.example');

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expectSecurityHeaders(response);
  });

  it.each([
    ['an origin outside every allowlist', 'https://evil.example'],
    ['an origin of another client form', 'https://www.outro.com.br'],
    ['no Origin header', null],
  ])('AC-LC-07 %s → 403 origin_not_allowed and no ACAO', async (_label, origin) => {
    // arrange
    const { post, harness } = buildLeadApp();

    // act
    const response = await post({ headers: { Origin: origin } });

    // assert
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: 'origin_not_allowed' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(harness.persistedRows().submissions).toBe(0);
    expectSecurityHeaders(response);
  });
});

describe('POST /v1/leads — behaviour through the real use case', () => {
  it('AC-LC-06 failed Turnstile → 403 before any field validation, without the reason', async () => {
    // arrange
    const { post, harness } = buildLeadApp();
    harness.antiBot.outcome = { outcome: 'failed', reason: 'token_reused' };

    // act: the body is also invalid, but only humans get per-field errors
    const response = await post({ body: validBody({ first_name: '<script>' }) });

    // assert
    const text = await response.text();
    expect(response.status).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ code: 'bot_verification_failed' });
    expect(text).not.toContain('token_reused');
    expect(text).not.toContain('first_name');
    expect(harness.rateLimiter.botFailures).toEqual([CLIENT_IP]);
  });

  it('Turnstile unreachable → 503 with Retry-After', async () => {
    const { post, harness } = buildLeadApp();
    harness.antiBot.outcome = { outcome: 'unavailable' };

    const response = await post();

    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ code: 'bot_verification_unavailable' });
    expect(response.headers.get('Retry-After')).toBe('5');
  });

  it('unknown or paused form → 404 form_not_found', async () => {
    const { post, harness } = buildLeadApp();
    harness.forms.deactivate('frm_lp_principal');

    const response = await post();

    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({ code: 'form_not_found' });
  });

  it.each([
    ['ip', 'ip'],
    ['form', 'form'],
    ['email', 'email'],
  ] as const)('AC-LC-08 %s limit exceeded → 429 with Retry-After', async (_label, scope) => {
    // arrange
    const { post, harness, metrics } = buildLeadApp();
    harness.rateLimiter[scope] = { allowed: false, retryAfterSeconds: 600 };

    // act
    const response = await post();

    // assert
    expect(response.status).toBe(429);
    expect(await json(response)).toMatchObject({ code: 'rate_limited' });
    expect(response.headers.get('Retry-After')).toBe('600');
    expect(metrics.records).toContainEqual({
      name: 'ratelimit.blocked',
      value: 1,
      attributes: { scope },
    });
    expectSecurityHeaders(response);
  });

  it('AC-LC-09 same key and payload with a new token replays the identical 202', async () => {
    // arrange
    const { post, harness } = buildLeadApp();

    // act
    const first = await post();
    const second = await post({ body: validBody({ turnstile_token: '0.AnotherToken' }) });

    // assert
    expect(second.status).toBe(202);
    expect(await json(second)).toEqual(await json(first));
    expect(harness.persistedRows().submissions).toBe(1);
  });

  it('AC-LC-10 same key with a different payload → 422 idempotency_key_reused', async () => {
    const { post, harness } = buildLeadApp();
    await post();

    const response = await post({ body: validBody({ first_name: 'Joana' }) });

    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ code: 'idempotency_key_reused' });
    expect(harness.persistedRows().submissions).toBe(1);
  });

  it('AC-LC-11 unknown field → 400 validation_failed with not_allowed', async () => {
    const { post } = buildLeadApp();

    const response = await post({ body: validBody({ stage: 'won' }) });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      code: 'validation_failed',
      errors: [{ field: 'stage', code: 'not_allowed' }],
    });
  });

  it('AC-LC-02 a missing required field → 400 with that field and code required', async () => {
    const { post } = buildLeadApp();
    const withoutEmail = Object.fromEntries(
      Object.entries(validBody()).filter(([field]) => field !== 'email'),
    );

    const response = await post({ body: withoutEmail });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      errors: [{ field: 'email', code: 'required' }],
    });
  });

  it('AC-LC-14 SQL/XSS payloads are stored literally in message and refused in first_name', async () => {
    // arrange
    const payload = `'; DROP TABLE crm.leads; -- <script>alert(1)</script> $$ ' OR 1=1--`;
    const { post, harness } = buildLeadApp();

    // act
    const accepted = await post({ body: validBody({ message: payload }) });
    const refused = await post({
      body: validBody({ first_name: "Robert'); DROP--" }),
      headers: { 'Idempotency-Key': SECOND_KEY },
    });

    // assert
    expect(accepted.status).toBe(202);
    expect(harness.submissions.records[0]?.message).toBe(payload);
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({
      errors: [{ field: 'first_name', code: 'not_allowed_characters' }],
    });
  });

  it('AC-LC-05 honeypot → 202 and nothing persisted', async () => {
    const { post, harness, metrics } = buildLeadApp();

    const response = await post({ body: validBody({ hp: 'http://spam.example' }) });

    await expectAcceptedShape(response);
    expect(harness.persistedRows()).toEqual({
      leads: 0,
      activities: 0,
      submissions: 0,
      consents: 0,
      outbox: 0,
      audit: 0,
    });
    expect(metrics.records[0]).toMatchObject({ attributes: { outcome: 'honeypot' } });
  });

  it('R2 new lead, existing lead and honeypot are indistinguishable (status, keys, headers)', async () => {
    // arrange
    const { post } = buildLeadApp();
    const trackingOf = (eventId: string) => ({ event_id: eventId, utm_source: 'meta' });

    // act
    const created = await post();
    const existing = await post({
      headers: { 'Idempotency-Key': SECOND_KEY },
      body: validBody({ tracking: trackingOf(SECOND_EVENT_ID) }),
    });
    const honeypot = await post({
      headers: { 'Idempotency-Key': THIRD_KEY },
      body: validBody({ hp: 'bot', tracking: trackingOf(THIRD_EVENT_ID) }),
    });

    // assert
    const responses = [created, existing, honeypot];
    for (const response of responses) {
      await expectAcceptedShape(response.clone());
    }
    const shapes = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        bodyKeys: Object.keys(await json(response)).sort(),
        headerNames: [...response.headers.keys()].sort(),
        contentType: response.headers.get('Content-Type'),
      })),
    );
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });
});

describe('POST /v1/leads — unexpected failures', () => {
  it('AC-LC-18 an adapter that throws → 500 internal_error with no internal detail', async () => {
    // arrange
    const { post, harness, logLines } = buildLeadApp();
    harness.outbox.failure = new Error(INTERNAL_DETAIL);

    // act
    const response = await post();

    // assert
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ code: 'internal_error', status: 500 });
    expect(JSON.parse(text)).toHaveProperty('correlation_id', response.headers.get('X-Request-Id'));
    expect(text).not.toContain('crm.leads');
    expect(text).not.toContain('db.ts');
    expect(text).not.toMatch(/\bat\s.+:\d+/);
    expect(harness.persistedRows().submissions).toBe(0);
    expect(logLines.join('')).toContain('unhandled error');
    expectSecurityHeaders(response);
  });

  it('AC-LC-18 database unavailable → 503 service_unavailable with Retry-After', async () => {
    // arrange
    const { post, harness } = buildLeadApp();
    harness.outbox.failure = new DependencyUnavailableError('database', {
      cause: new Error(INTERNAL_DETAIL),
    });

    // act
    const response = await post();

    // assert
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: 'service_unavailable' });
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(text).not.toContain('crm.leads');
    expect(text).not.toContain('database');
    expectSecurityHeaders(response);
  });

  it('lets the client retry after a failure: the idempotency claim is released', async () => {
    const { post, harness } = buildLeadApp();
    harness.outbox.failure = new Error(INTERNAL_DETAIL);
    await post();
    harness.outbox.failure = null;

    const retry = await post();

    expect(retry.status).toBe(202);
  });
});

describe('POST /v1/leads — metrics and logs', () => {
  const requestRecords = (app: LeadApp) =>
    app.metrics.records.filter((record) => record.name === 'lead_capture.requests');

  it('records lead_capture.requests{outcome} for accepted and replayed requests', async () => {
    const app = buildLeadApp();

    await app.post();
    await app.post({ body: validBody({ turnstile_token: '0.Another' }) });

    expect(requestRecords(app).map((record) => record.attributes)).toEqual([
      { outcome: 'accepted' },
      { outcome: 'replayed' },
    ]);
  });

  it('records lead_capture.requests{outcome: rejected, code} for guard and use case refusals', async () => {
    const app = buildLeadApp();

    await app.post({ headers: { 'Content-Type': 'text/plain' } });
    await app.post({ headers: { Origin: 'https://evil.example' } });

    expect(requestRecords(app).map((record) => record.attributes)).toEqual([
      { outcome: 'rejected', code: 'unsupported_media_type' },
      { outcome: 'rejected', code: 'origin_not_allowed' },
    ]);
  });

  it('records antibot.failures{reason} for operators', async () => {
    const app = buildLeadApp();
    app.harness.antiBot.outcome = { outcome: 'failed', reason: 'stale_challenge' };

    await app.post();

    expect(app.metrics.records).toContainEqual({
      name: 'antibot.failures',
      value: 1,
      attributes: { reason: 'stale_challenge' },
    });
  });

  it('records unexpected failures as outcome=error with the code the client sees', async () => {
    const app = buildLeadApp();
    app.harness.outbox.failure = new Error(INTERNAL_DETAIL);

    await app.post();

    expect(requestRecords(app).map((record) => record.attributes)).toEqual([
      { outcome: 'error', code: 'internal_error' },
    ]);
  });

  it('AC-LC-17 no log line carries e-mail, WhatsApp, name, company, IP or token', async () => {
    // arrange
    const app = buildLeadApp();
    app.harness.outbox.failure = new Error(INTERNAL_DETAIL);

    // act: accepted, replayed, honeypot, failed bot check, guard errors and a 500
    await app.post({ headers: { 'Idempotency-Key': THIRD_KEY } });
    app.harness.outbox.failure = null;
    await app.post();
    await app.post({ body: validBody({ turnstile_token: '0.Another' }) });
    await app.post({
      headers: { 'Idempotency-Key': SECOND_KEY },
      body: validBody({ hp: 'bot', tracking: { event_id: SECOND_EVENT_ID } }),
    });
    app.harness.antiBot.outcome = { outcome: 'failed', reason: 'invalid_token' };
    await app.post({ headers: { 'Idempotency-Key': '44444444-4444-4444-8444-444444444444' } });
    await app.post({ body: `{"email":"${INPUT_MARKER}@x.com` });
    await app.post({ headers: { 'Content-Type': 'text/plain' } });

    // assert
    const logs = app.logLines.join('').toLowerCase();
    expect(logs.length).toBeGreaterThan(0);
    for (const forbidden of [
      'maria@empresa.com.br',
      'empresa.com.br',
      '5511912345678',
      '91234-5678',
      'maria',
      'silva',
      'empresa ltda',
      CLIENT_IP,
      '0.abcdef',
      '0.another',
      INPUT_MARKER.toLowerCase(),
    ]) {
      expect(logs, forbidden).not.toContain(forbidden);
    }
  });

  it('logs one lead-capture line per request with IDs and codes only', async () => {
    const app = buildLeadApp();

    await app.post();

    const lines = app.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.message === 'lead capture handled');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      module: 'lead-capture',
      outcome: 'accepted',
      submission_id: expect.stringMatching(UUID_PATTERN) as unknown,
      event_id: CLIENT_EVENT_ID,
    });
  });
});
