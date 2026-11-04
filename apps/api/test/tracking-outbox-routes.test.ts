import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '#/app.ts';
import type { DispatchOutboxEvent } from '#/modules/tracking/application/dispatch-outbox-event.ts';
import type {
  SignatureVerificationRequest,
  SignatureVerifier,
} from '#/modules/tracking/application/ports.ts';
import type { SweepOutbox } from '#/modules/tracking/application/sweep-outbox.ts';
import { QstashSignatureVerifier } from '#/modules/tracking/infrastructure/qstash-signature.ts';
import { createOutboxRoutes } from '#/modules/tracking/presentation/http.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';
import type { OutboxEventId } from '#/shared/ids.ts';
import { FakeClock } from './fakes/clock.ts';
import { WORKSPACE_ID } from './fakes/tracking.ts';

const BASE_URL = 'https://api.example.test';
const DISPATCH_URL = `${BASE_URL}/internal/v1/outbox/dispatch`;
const SWEEP_URL = `${BASE_URL}/internal/v1/outbox/sweep`;
const EVENT_ID = '0193aaaa-0000-7000-8000-0000000000b2';
const VALID_SIGNATURE = 'valid-signature';
const CURRENT_KEY = 'test-current-signing-key-0001';
const NEXT_KEY = 'test-next-signing-key-0002';

const DISPATCH_BODY = JSON.stringify({ outbox_event_id: EVENT_ID });

/** Accepts exactly one signature value and records every request it is asked to verify. */
class FakeSignatureVerifier implements SignatureVerifier {
  readonly requests: SignatureVerificationRequest[] = [];

  verify(request: SignatureVerificationRequest): Promise<boolean> {
    this.requests.push(request);
    return Promise.resolve(request.signature === VALID_SIGNATURE);
  }
}

function buildApp(overrides: { readonly verifier?: SignatureVerifier } = {}) {
  const verifier = new FakeSignatureVerifier();
  const dispatchOutboxEvent = vi.fn<DispatchOutboxEvent>(() =>
    Promise.resolve({ kind: 'completed' as const }),
  );
  const sweepOutbox = vi.fn<SweepOutbox>(() =>
    Promise.resolve({ republished: 3, publishFailures: 0, deadLettered: 0 }),
  );
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const app = createApp({
    config: loadConfig({ APP_ENV: 'development', CORS_ALLOWED_ORIGINS: 'https://lp.example.test' }),
    logger: createLogger({ level: 'info', appEnv: 'test', destination }),
    routes: [
      createOutboxRoutes({
        verifier: overrides.verifier ?? verifier,
        dispatchOutboxEvent,
        sweepOutbox,
        workspaceId: WORKSPACE_ID,
        publicApiBaseUrl: `${BASE_URL}/`,
      }),
    ],
  });
  return { app, verifier, dispatchOutboxEvent, sweepOutbox, lines };
}

function post(
  app: ReturnType<typeof buildApp>['app'],
  path: string,
  body: string,
  signature: string | null = VALID_SIGNATURE,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature !== null) headers['Upstash-Signature'] = signature;
  return Promise.resolve(app.request(path, { method: 'POST', headers, body }));
}

describe('AC-TR-03 POST /internal/v1/outbox/dispatch authenticates before anything else', () => {
  it.each([null, '', 'forged'])(
    'AC-TR-03: signature %j → generic 401 and the use case is never called',
    async (signature) => {
      const { app, dispatchOutboxEvent } = buildApp();

      const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY, signature);

      expect(response.status).toBe(401);
      expect(response.headers.get('Content-Type')).toContain('application/problem+json');
      expect(await response.json()).toMatchObject({ status: 401, code: 'unauthorized' });
      expect(dispatchOutboxEvent).not.toHaveBeenCalled();
    },
  );

  it('AC-TR-03: a bad signature wins over a malformed body (401, not 400)', async () => {
    const { app, dispatchOutboxEvent } = buildApp();

    const response = await post(app, '/internal/v1/outbox/dispatch', '{not json', 'forged');

    expect(response.status).toBe(401);
    expect(dispatchOutboxEvent).not.toHaveBeenCalled();
  });

  it('verifies the raw body and the configured absolute URL, not the forwarded Host', async () => {
    const { app, verifier } = buildApp();
    const unusualSpacing = `{ "outbox_event_id" : "${EVENT_ID}" }`;

    await app.request('http://internal-host.invalid/internal/v1/outbox/dispatch', {
      method: 'POST',
      headers: { 'Upstash-Signature': VALID_SIGNATURE, 'Content-Type': 'application/json' },
      body: unusualSpacing,
    });

    expect(verifier.requests).toEqual([
      { signature: VALID_SIGNATURE, rawBody: unusualSpacing, url: DISPATCH_URL },
    ]);
  });

  it('does not leak which barrier failed or any internal detail in the 401', async () => {
    const { app } = buildApp();

    const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY, 'forged');
    const text = await response.text();

    expect(text).not.toMatch(/signature|jwt|key|upstash/iu);
  });
});

describe('POST /internal/v1/outbox/dispatch', () => {
  it('runs the use case for the configured workspace and answers 200 with no body', async () => {
    const { app, dispatchOutboxEvent } = buildApp();

    const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(dispatchOutboxEvent).toHaveBeenCalledTimes(1);
    const [command] = dispatchOutboxEvent.mock.calls[0] ?? [];
    expect(command).toMatchObject({
      workspaceId: WORKSPACE_ID,
      outboxEventId: EVENT_ID as OutboxEventId,
    });
    expect(command?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it.each([
    ['already_processed', { kind: 'already_processed' as const }],
    ['dead_lettered', { kind: 'dead_lettered' as const }],
    ['not_found', { kind: 'not_found' as const }],
  ])('answers 200 for %s (nothing left to retry)', async (_label, outcome) => {
    const { app, dispatchOutboxEvent } = buildApp();
    dispatchOutboxEvent.mockResolvedValueOnce(outcome);

    const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY);

    expect(response.status).toBe(200);
  });

  it.each(['delivery_failed', 'busy'] as const)(
    'AC-TR-05: answers a generic 500 problem when the outcome is retry_later (%s)',
    async (reason) => {
      const { app, dispatchOutboxEvent } = buildApp();
      dispatchOutboxEvent.mockResolvedValueOnce({ kind: 'retry_later', reason });

      const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY);

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ status: 500, code: 'internal_error' });
    },
  );

  it('answers a generic 500 (QStash retries) when the use case throws, without leaking the error', async () => {
    const { app, dispatchOutboxEvent } = buildApp();
    dispatchOutboxEvent.mockRejectedValueOnce(
      new Error('relation "tracking.outbox_events" is down'),
    );

    const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('tracking.outbox_events');
  });

  it.each([
    ['syntactically invalid JSON', '{nope', 'invalid_json'],
    ['an empty body', '', 'invalid_json'],
    ['a missing id', '{}', 'validation_failed'],
    ['a non-uuid id', '{"outbox_event_id":"not-a-uuid"}', 'validation_failed'],
    ['a non-string id', '{"outbox_event_id":42}', 'validation_failed'],
    [
      'an extra field (.strict())',
      `{"outbox_event_id":"${EVENT_ID}","extra":true}`,
      'validation_failed',
    ],
    [
      'a client-chosen workspace (tenant never comes from the request)',
      `{"outbox_event_id":"${EVENT_ID}","workspace_id":"${WORKSPACE_ID}"}`,
      'validation_failed',
    ],
    ['an array', `[${DISPATCH_BODY}]`, 'validation_failed'],
  ])('answers 400 for %s', async (_label, body, code) => {
    const { app, dispatchOutboxEvent } = buildApp();

    const response = await post(app, '/internal/v1/outbox/dispatch', body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(dispatchOutboxEvent).not.toHaveBeenCalled();
  });

  it('answers 413 above 1 KB (a signed body that is not a dispatch message)', async () => {
    const { app, dispatchOutboxEvent } = buildApp();
    const padded = JSON.stringify({ outbox_event_id: EVENT_ID, pad: 'x'.repeat(2_000) });

    const response = await post(app, '/internal/v1/outbox/dispatch', padded);

    expect(response.status).toBe(413);
    expect(dispatchOutboxEvent).not.toHaveBeenCalled();
  });
});

describe('POST /internal/v1/outbox/sweep', () => {
  it('rejects a missing or invalid signature with 401 and does not sweep', async () => {
    const { app, sweepOutbox } = buildApp();

    const missing = await post(app, '/internal/v1/outbox/sweep', '{}', null);
    const forged = await post(app, '/internal/v1/outbox/sweep', '{}', 'forged');

    expect(missing.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(sweepOutbox).not.toHaveBeenCalled();
  });

  it('verifies the sweep URL', async () => {
    const { app, verifier } = buildApp();

    await post(app, '/internal/v1/outbox/sweep', '{}');

    expect(verifier.requests[0]?.url).toBe(SWEEP_URL);
  });

  it('sweeps the configured workspace and answers {republished}', async () => {
    const { app, sweepOutbox } = buildApp();

    const response = await post(app, '/internal/v1/outbox/sweep', '{}');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ republished: 3 });
    expect(sweepOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID }),
    );
  });

  it.each([
    ['unknown fields', '{"workspace_id":"x"}'],
    ['a non-object', '[]'],
    ['a bare string', '"sweep"'],
  ])('answers 400 for %s', async (_label, body) => {
    const { app, sweepOutbox } = buildApp();

    const response = await post(app, '/internal/v1/outbox/sweep', body);

    expect(response.status).toBe(400);
    expect(sweepOutbox).not.toHaveBeenCalled();
  });
});

describe('AC-TR-03 with the real QStash signature verifier', () => {
  const NOW_MS = Date.parse('2026-11-03T12:00:00.000Z');
  const NOW_S = NOW_MS / 1000;
  const encoder = new TextEncoder();
  const bodyHash = (body: string) => createHash('sha256').update(body, 'utf8').digest('base64url');

  async function token(options: { body?: string; exp?: number; sub?: string; key?: string } = {}) {
    return new SignJWT({ body: bodyHash(options.body ?? DISPATCH_BODY) })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('Upstash')
      .setSubject(options.sub ?? DISPATCH_URL)
      .setIssuedAt(NOW_S)
      .setNotBefore(NOW_S)
      .setExpirationTime(options.exp ?? NOW_S + 300)
      .sign(encoder.encode(options.key ?? NEXT_KEY));
  }

  function appWithRealVerifier() {
    const verifier = new QstashSignatureVerifier(
      { currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY },
      {
        clock: new FakeClock(new Date(NOW_MS)),
        logger: createLogger({ level: 'silent', appEnv: 'test' }),
        metrics: createRecordingMetrics(),
      },
    );
    return buildApp({ verifier });
  }

  it('AC-TR-03: accepts a correctly signed request (signed with the NEXT key during rotation)', async () => {
    const { app, dispatchOutboxEvent } = appWithRealVerifier();

    const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY, await token());

    expect(response.status).toBe(200);
    expect(dispatchOutboxEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a signature computed over a different body',
      () => token({ body: '{"outbox_event_id":"x"}' }),
    ],
    ['an expired signature', () => token({ exp: NOW_S - 60 })],
    ['a signature issued for the sweep URL', () => token({ sub: SWEEP_URL })],
    ['a signature from an unknown key', () => token({ key: 'another-key-entirely-0003' })],
  ])('AC-TR-03: %s → 401 and no effect', async (_label, sign) => {
    const { app, dispatchOutboxEvent } = appWithRealVerifier();

    const response = await post(app, '/internal/v1/outbox/dispatch', DISPATCH_BODY, await sign());

    expect(response.status).toBe(401);
    expect(dispatchOutboxEvent).not.toHaveBeenCalled();
  });
});
