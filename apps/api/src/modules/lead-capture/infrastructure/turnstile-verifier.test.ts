import { Writable } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AntiBotVerificationRequest,
  Clock,
} from '#/modules/lead-capture/application/ports.ts';
import {
  createTurnstileVerifier,
  TURNSTILE_SITEVERIFY_URL,
} from '#/modules/lead-capture/infrastructure/turnstile-verifier.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';
import type { IdempotencyKey } from '#/shared/ids.ts';

const SECRET = 'fake-secret-aaaa';
const TOKEN = '0.opaque-turnstile-token-value';
const REMOTE_IP = '203.0.113.7';
const NOW = new Date('2026-11-03T12:00:00.000Z');

const clock: Clock = { now: () => NOW, sleep: () => Promise.resolve() };

const baseRequest: AntiBotVerificationRequest = {
  token: TOKEN,
  remoteIp: REMOTE_IP,
  expectedHostnames: ['www.example.com.br'],
  expectedAction: 'lead_submit',
  idempotencyKey: '00000000-0000-4000-8000-000000000001' as IdempotencyKey,
};

/** Cloudflare's documented success payload, `challenge_ts` 20 s before `NOW`. */
const successBody = {
  success: true,
  'error-codes': [],
  challenge_ts: new Date(NOW.getTime() - 20_000).toISOString(),
  hostname: 'www.example.com.br',
  action: 'lead_submit',
  cdata: '',
};

/** Copy of a response body without one field (a field Cloudflare did not send). */
function without(body: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([name]) => name !== field));
}

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(() => {
  server.close();
});

interface CapturedCall {
  readonly url: string;
  readonly method: string;
  readonly contentType: string | null;
  readonly body: Record<string, unknown>;
}

/** Registers a siteverify handler answering `respond`, recording every call it receives. */
function mockSiteverify(respond: () => Response | Promise<Response>): CapturedCall[] {
  const calls: CapturedCall[] = [];
  server.use(
    http.post(TURNSTILE_SITEVERIFY_URL, async ({ request }) => {
      calls.push({
        url: request.url,
        method: request.method,
        contentType: request.headers.get('content-type'),
        body: (await request.json()) as Record<string, unknown>,
      });
      return respond();
    }),
  );
  return calls;
}

function setup() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'debug', appEnv: 'test', destination });
  const metrics = createRecordingMetrics();
  const verifier = createTurnstileVerifier({ secretKey: SECRET, clock, logger, metrics });
  return { verifier, metrics, logs: () => lines.join('') };
}

describe('createTurnstileVerifier', () => {
  it('passes a fresh token whose hostname and action match the form', async () => {
    // arrange
    mockSiteverify(() => HttpResponse.json(successBody));
    const { verifier, metrics } = setup();
    // act
    const result = await verifier.verify(baseRequest);
    // assert
    expect(result).toEqual({ outcome: 'passed', challengeAgeSeconds: 20, ephemeralId: null });
    expect(metrics.records).toEqual([]);
  });

  it('exposes the enterprise ephemeral id when Cloudflare returns one', async () => {
    mockSiteverify(() =>
      HttpResponse.json({ ...successBody, metadata: { ephemeral_id: 'x:9f78e0ed210960d7' } }),
    );
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toMatchObject({
      outcome: 'passed',
      ephemeralId: 'x:9f78e0ed210960d7',
    });
  });

  it('tolerates response fields it does not know about', async () => {
    mockSiteverify(() => HttpResponse.json({ ...successBody, cdata: 'x', future_field: [1, 2] }));
    const { verifier } = setup();
    expect((await verifier.verify(baseRequest)).outcome).toBe('passed');
  });

  it('sends the secret only in the POST body and never in the URL', async () => {
    // arrange
    const calls = mockSiteverify(() => HttpResponse.json(successBody));
    const { verifier } = setup();
    // act
    await verifier.verify(baseRequest);
    // assert
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(call?.url).not.toContain(SECRET);
    expect(call?.contentType).toContain('application/json');
    expect(call?.body).toEqual({
      secret: SECRET,
      response: TOKEN,
      remoteip: REMOTE_IP,
      idempotency_key: baseRequest.idempotencyKey,
    });
  });

  it('omits remoteip when the client IP is unknown', async () => {
    const calls = mockSiteverify(() => HttpResponse.json(successBody));
    const { verifier } = setup();
    await verifier.verify({ ...baseRequest, remoteIp: null });
    expect(calls[0]?.body).not.toHaveProperty('remoteip');
  });

  it('fails with invalid_token when Cloudflare reports invalid-input-response', async () => {
    mockSiteverify(() =>
      HttpResponse.json({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    const { verifier, metrics } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'invalid_token',
    });
    expect(metrics.records).toEqual([
      { name: 'antibot.failures', value: 1, attributes: { reason: 'invalid_token' } },
    ]);
  });

  it('fails with token_reused when Cloudflare reports timeout-or-duplicate', async () => {
    mockSiteverify(() =>
      HttpResponse.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'token_reused',
    });
  });

  it('fails with invalid_token on success:false without any error code', async () => {
    mockSiteverify(() => HttpResponse.json({ success: false }));
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'invalid_token',
    });
  });

  it('fails with hostname_mismatch when the token was issued for another site', async () => {
    mockSiteverify(() => HttpResponse.json({ ...successBody, hostname: 'evil.example.net' }));
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'hostname_mismatch',
    });
  });

  it('fails with hostname_mismatch when the response carries no hostname', async () => {
    mockSiteverify(() => HttpResponse.json(without(successBody, 'hostname')));
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'hostname_mismatch',
    });
  });

  it('matches hostnames case-insensitively against any allowed hostname', async () => {
    mockSiteverify(() => HttpResponse.json({ ...successBody, hostname: 'LP.Example.com.br' }));
    const { verifier } = setup();
    const result = await verifier.verify({
      ...baseRequest,
      expectedHostnames: ['www.example.com.br', 'lp.example.com.br'],
    });
    expect(result.outcome).toBe('passed');
  });

  it('fails with hostname_mismatch when the form has no allowed hostname', async () => {
    mockSiteverify(() => HttpResponse.json(successBody));
    const { verifier } = setup();
    expect(await verifier.verify({ ...baseRequest, expectedHostnames: [] })).toEqual({
      outcome: 'failed',
      reason: 'hostname_mismatch',
    });
  });

  it('fails with action_mismatch when the widget action differs from the form action', async () => {
    mockSiteverify(() => HttpResponse.json({ ...successBody, action: 'login' }));
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'action_mismatch',
    });
  });

  it('fails with action_mismatch when the response carries no action', async () => {
    mockSiteverify(() => HttpResponse.json(without(successBody, 'action')));
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'action_mismatch',
    });
  });

  it('fails with stale_challenge when challenge_ts is older than 300 seconds', async () => {
    mockSiteverify(() =>
      HttpResponse.json({
        ...successBody,
        challenge_ts: new Date(NOW.getTime() - 301_000).toISOString(),
      }),
    );
    const { verifier, metrics } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'stale_challenge',
    });
    expect(metrics.records[0]?.attributes).toEqual({ reason: 'stale_challenge' });
  });

  it('accepts a challenge exactly 300 seconds old', async () => {
    mockSiteverify(() =>
      HttpResponse.json({
        ...successBody,
        challenge_ts: new Date(NOW.getTime() - 300_000).toISOString(),
      }),
    );
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toMatchObject({
      outcome: 'passed',
      challengeAgeSeconds: 300,
    });
  });

  it('treats a challenge_ts slightly in the future as clock skew with age zero', async () => {
    mockSiteverify(() =>
      HttpResponse.json({
        ...successBody,
        challenge_ts: new Date(NOW.getTime() + 2_000).toISOString(),
      }),
    );
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toMatchObject({
      outcome: 'passed',
      challengeAgeSeconds: 0,
    });
  });

  it.each([
    ['missing', undefined],
    ['unparseable', 'yesterday-ish'],
  ])('fails with stale_challenge when challenge_ts is %s', async (_label, challengeTs) => {
    const withoutTimestamp = without(successBody, 'challenge_ts');
    mockSiteverify(() =>
      HttpResponse.json(
        challengeTs === undefined
          ? withoutTimestamp
          : { ...withoutTimestamp, challenge_ts: challengeTs },
      ),
    );
    const { verifier } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({
      outcome: 'failed',
      reason: 'stale_challenge',
    });
  });

  it('returns unavailable when siteverify does not answer within 3 seconds', async () => {
    // arrange
    vi.useFakeTimers();
    mockSiteverify(() => new Promise<Response>(() => undefined));
    const { verifier, metrics, logs } = setup();
    // act
    const pending = verifier.verify(baseRequest);
    await vi.advanceTimersByTimeAsync(2_999);
    const settledEarly = await Promise.race([pending, Promise.resolve('still-pending' as const)]);
    await vi.advanceTimersByTimeAsync(1);
    // assert
    expect(settledEarly).toBe('still-pending');
    expect(await pending).toEqual({ outcome: 'unavailable' });
    expect(metrics.records).toEqual([
      { name: 'antibot.failures', value: 1, attributes: { reason: 'unavailable' } },
    ]);
    expect(logs()).toContain('"cause":"timeout"');
  });

  it('returns unavailable on a network error', async () => {
    mockSiteverify(() => HttpResponse.error());
    const { verifier, logs } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({ outcome: 'unavailable' });
    expect(logs()).toContain('"cause":"network"');
  });

  it.each([500, 502, 503, 429, 400])(
    'returns unavailable when siteverify answers HTTP %i',
    async (status) => {
      mockSiteverify(() => HttpResponse.json({ success: false }, { status }));
      const { verifier } = setup();
      expect(await verifier.verify(baseRequest)).toEqual({ outcome: 'unavailable' });
    },
  );

  it.each([
    ['a non-JSON body', () => new HttpResponse('<html>bad gateway</html>', { status: 200 })],
    ['a JSON body of the wrong shape', () => HttpResponse.json({ success: 'yes' })],
    ['a JSON array', () => HttpResponse.json([true])],
  ])('returns unavailable when the response is %s', async (_label, respond) => {
    mockSiteverify(respond);
    const { verifier, logs } = setup();
    expect(await verifier.verify(baseRequest)).toEqual({ outcome: 'unavailable' });
    expect(logs()).toContain('"cause":"invalid_response"');
  });

  it.each(['invalid-input-secret', 'missing-input-secret', 'internal-error'])(
    'returns unavailable, not a visitor failure, when Cloudflare reports %s',
    async (code) => {
      mockSiteverify(() => HttpResponse.json({ success: false, 'error-codes': [code] }));
      const { verifier, logs } = setup();
      expect(await verifier.verify(baseRequest)).toEqual({ outcome: 'unavailable' });
      expect(logs()).toContain('"level":"error"');
    },
  );

  it('does not follow redirects, so the secret is never replayed elsewhere', async () => {
    // arrange
    const redirected: string[] = [];
    mockSiteverify(
      () =>
        new HttpResponse(null, {
          status: 307,
          headers: { location: 'https://attacker.example.net/collect' },
        }),
    );
    server.use(
      http.post('https://attacker.example.net/collect', ({ request }) => {
        redirected.push(request.url);
        return HttpResponse.json(successBody);
      }),
    );
    const { verifier } = setup();
    // act
    const result = await verifier.verify(baseRequest);
    // assert
    expect(result).toEqual({ outcome: 'unavailable' });
    expect(redirected).toEqual([]);
  });

  it('never writes the secret, the token or the client IP to the logs', async () => {
    // arrange: provoke every logging path
    const { verifier, logs } = setup();
    mockSiteverify(() => HttpResponse.json({ success: false }, { status: 500 }));
    await verifier.verify(baseRequest);
    server.resetHandlers();
    mockSiteverify(() => HttpResponse.error());
    await verifier.verify(baseRequest);
    server.resetHandlers();
    mockSiteverify(() =>
      HttpResponse.json({ success: false, 'error-codes': ['invalid-input-secret'] }),
    );
    await verifier.verify(baseRequest);
    // assert
    const output = logs();
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(REMOTE_IP);
  });
});
