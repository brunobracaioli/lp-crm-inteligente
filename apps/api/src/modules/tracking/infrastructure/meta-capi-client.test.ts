import { Writable } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerConversionEvent } from '#/modules/tracking/application/ports.ts';
import { prepareServerConversion } from '#/modules/tracking/application/prepare-server-conversion.ts';
import { Delivery } from '#/modules/tracking/domain/delivery.ts';
import {
  CONSENT_GRANTED,
  EVENT_ID,
  LEAD_ID,
  aLeadFacts,
} from '#/modules/tracking/domain/lead-facts.fixture.ts';
import {
  MetaCapiClient,
  type MetaCapiClientConfig,
} from '#/modules/tracking/infrastructure/meta-capi-client.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';
import type { OutboxEventId } from '#/shared/ids.ts';

const PIXEL_ID = '123456789012345';
const ACCESS_TOKEN = 'EAAFake-access-token-for-tests-0001';
const EVENTS_URL = `https://graph.facebook.com/v25.0/${PIXEL_ID}/events`;
const NOW = new Date('2026-11-03T12:00:10.000Z');
const OUTBOX_EVENT_ID = '0192f3a0-1111-7222-8333-444455556666' as OutboxEventId;

const CONFIG: MetaCapiClientConfig = {
  pixelId: PIXEL_ID,
  accessToken: ACCESS_TOKEN,
  graphApiVersion: 'v25.0',
};

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
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

function captureLogs() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: createLogger({ level: 'debug', appEnv: 'test', destination }), lines };
}

function readyEvent(overrides: Parameters<typeof aLeadFacts>[0] = {}): ServerConversionEvent {
  const prepared = prepareServerConversion(aLeadFacts(overrides), 'meta_capi');
  if (prepared.kind !== 'ready') throw new Error(`event not ready: ${prepared.kind}`);
  return prepared.event;
}

function newClient(config: Partial<MetaCapiClientConfig> = {}, fetchImpl?: typeof fetch) {
  const logs = captureLogs();
  const metrics = createRecordingMetrics();
  const client = new MetaCapiClient(
    { ...CONFIG, ...config },
    { logger: logs.logger, metrics, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) },
  );
  return { client, metrics, logs };
}

/** Answers every CAPI call with `respond` and records what was sent. */
function mockCapi(respond: () => Response | Promise<Response>) {
  const requests: CapturedRequest[] = [];
  server.use(
    http.post(EVENTS_URL, async ({ request }) => {
      requests.push({
        url: request.url,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      });
      return respond();
    }),
  );
  return requests;
}

const ok = () => HttpResponse.json({ events_received: 1, messages: [], fbtrace_id: 'AbC123trace' });

describe('MetaCapiClient request', () => {
  it('posts the Lead with event_id, event_time in seconds, action_source and source url', async () => {
    const requests = mockCapi(ok);
    const { client } = newClient();

    const result = await client.send(readyEvent());

    expect(result).toEqual({ status: 'sent', httpStatus: 200, externalRef: 'AbC123trace' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    const [event] = requests[0]?.body.data as Record<string, unknown>[];
    expect(event).toMatchObject({
      event_name: 'Lead',
      event_time: 1793707200,
      event_id: EVENT_ID,
      action_source: 'website',
      event_source_url: 'https://lp.example.com/oferta?utm_source=meta',
      custom_data: {
        lead_source: 'meta',
        area_of_expertise: 'technology',
        company_size: '11_50',
        score_band: 'A',
      },
    });
  });

  it('sends IP, user agent, fbp and fbc unhashed, and omits them when absent', async () => {
    const requests = mockCapi(ok);
    const { client } = newClient();

    await client.send(readyEvent());
    await client.send(
      readyEvent({ consent: { ...CONSENT_GRANTED, adStorage: 'denied' }, clientIp: null }),
    );

    const userData = (index: number) =>
      ((requests[index]?.body.data as Record<string, unknown>[])[0]?.user_data ?? {}) as Record<
        string,
        unknown
      >;
    expect(userData(0)).toMatchObject({
      client_ip_address: '203.0.113.7',
      client_user_agent: 'Mozilla/5.0 (X11; Linux x86_64) TestAgent/1.0',
      fbp: 'fb.1.1730635200000.1116446470',
      fbc: 'fb.1.1793707200000.IwAR0TestClickId',
    });
    expect(Object.keys(userData(1))).not.toContain('fbp');
    expect(Object.keys(userData(1))).not.toContain('fbc');
    expect(Object.keys(userData(1))).not.toContain('client_ip_address');
  });

  it('uses the configured Graph API version in the path', async () => {
    server.use(http.post(`https://graph.facebook.com/v23.0/${PIXEL_ID}/events`, () => ok()));
    const { client } = newClient({ graphApiVersion: 'v23.0' });

    expect((await client.send(readyEvent())).status).toBe('sent');
  });

  it('passes test_event_code through only when configured', async () => {
    const requests = mockCapi(ok);

    await newClient().client.send(readyEvent());
    await newClient({ testEventCode: 'TEST12345' }).client.send(readyEvent());

    expect(requests[0]?.body).not.toHaveProperty('test_event_code');
    expect(requests[1]?.body.test_event_code).toBe('TEST12345');
  });

  it('rejects an invalid config naming the field, never the value', () => {
    const construct = () =>
      newClient({ pixelId: '../../other', accessToken: '' }, undefined).client;

    expect(construct).toThrow(/pixelId, accessToken/);
    expect(construct).not.toThrow(ACCESS_TOKEN);
    expect(() => newClient({ testEventCode: 'not-a-test-code' })).toThrow(/testEventCode/);
  });
});

describe('AC-TR-06 hashing and token hygiene', () => {
  it('AC-TR-06: em/ph/fn/ln/external_id are 64-char hex SHA-256 and no clear value is sent', async () => {
    const requests = mockCapi(ok);
    const { client } = newClient();

    await client.send(readyEvent());

    const rawBody = JSON.stringify(requests[0]?.body);
    const [event] = requests[0]?.body.data as { user_data: Record<string, string[]> }[];
    for (const field of ['em', 'ph', 'fn', 'ln', 'external_id'] as const) {
      expect(event?.user_data[field]).toHaveLength(1);
      expect(event?.user_data[field]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const clear of [
      'Maria',
      'maria',
      'Souza',
      'souza',
      'maria.souza',
      '@example.com',
      '5511987654321',
      '987654321',
      LEAD_ID,
    ]) {
      expect(rawBody).not.toContain(clear);
    }
  });

  it('AC-TR-06: the access_token is in the JSON body and in no URL or header', async () => {
    const requests = mockCapi(ok);
    const { client } = newClient();

    await client.send(readyEvent());

    const [request] = requests;
    expect(request?.body.access_token).toBe(ACCESS_TOKEN);
    expect(request?.url).toBe(EVENTS_URL);
    expect(new URL(request?.url ?? '').search).toBe('');
    expect(request?.url).not.toContain('access_token');
    expect(request?.url).not.toContain(ACCESS_TOKEN);
    for (const [name, value] of request?.headers.entries() ?? []) {
      expect(`${name}: ${value}`).not.toContain(ACCESS_TOKEN);
    }
  });

  it('AC-TR-06: no log line contains the access_token, response text or identifiers on any failure path', async () => {
    const { client, logs } = newClient();
    const hostile = () =>
      HttpResponse.json(
        { error: { message: `bad token ${ACCESS_TOKEN} for maria.souza@example.com`, code: 100 } },
        { status: 400 },
      );

    mockCapi(hostile);
    await client.send(readyEvent());
    mockCapi(() => HttpResponse.text(`oops ${ACCESS_TOKEN}`, { status: 502 }));
    await client.send(readyEvent());
    mockCapi(() => HttpResponse.error());
    await client.send(readyEvent());

    const output = logs.lines.join('');
    expect(output).toContain('conversion delivery failed');
    expect(output).not.toContain(ACCESS_TOKEN);
    expect(output).not.toContain('access_token');
    expect(output).not.toContain('maria.souza');
    expect(output).not.toContain('bad token');
  });
});

describe('AC-TR-05 failure mapping', () => {
  it('AC-TR-05: Meta 500 is retryable and leaves the delivery failed with attempts incremented', async () => {
    mockCapi(() => HttpResponse.json({}, { status: 500 }));
    const { client } = newClient();

    const result = await client.send(readyEvent());

    expect(result).toEqual({
      status: 'retryable_failure',
      httpStatus: 500,
      errorCode: 'meta_server_error',
    });
    const delivery = Delivery.open(OUTBOX_EVENT_ID, 'meta_capi', NOW).recordAttempt(result, NOW);
    expect(delivery.ok && delivery.value).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastHttpStatus: 500,
      lastErrorCode: 'meta_server_error',
    });
    expect(delivery.ok && delivery.value.awaitsRetry).toBe(true);
  });

  it('AC-TR-05: Meta 400 is permanent and the delivery goes dead without retry', async () => {
    mockCapi(() =>
      HttpResponse.json(
        { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } },
        { status: 400 },
      ),
    );
    const { client } = newClient();

    const result = await client.send(readyEvent());

    expect(result).toEqual({
      status: 'permanent_failure',
      httpStatus: 400,
      errorCode: 'meta_rejected',
    });
    const delivery = Delivery.open(OUTBOX_EVENT_ID, 'meta_capi', NOW).recordAttempt(result, NOW);
    expect(delivery.ok && delivery.value).toMatchObject({ status: 'dead', attempts: 1 });
    expect(delivery.ok && delivery.value.awaitsRetry).toBe(false);
  });

  it('AC-TR-05: a timeout aborts the call after timeoutMs and is retryable', async () => {
    vi.useFakeTimers();
    const hangingFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
    const { client } = newClient({ timeoutMs: 5_000 }, hangingFetch);

    const pending = client.send(readyEvent());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hangingFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toEqual({
      status: 'retryable_failure',
      httpStatus: null,
      errorCode: 'meta_timeout',
    });
    const delivery = Delivery.open(OUTBOX_EVENT_ID, 'meta_capi', NOW).recordAttempt(result, NOW);
    expect(delivery.ok && delivery.value).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('AC-TR-05: a network error is retryable', async () => {
    mockCapi(() => HttpResponse.error());
    const { client } = newClient();

    expect(await client.send(readyEvent())).toEqual({
      status: 'retryable_failure',
      httpStatus: null,
      errorCode: 'meta_network',
    });
  });

  it('treats 429 as retryable rate limiting', async () => {
    mockCapi(() => HttpResponse.json({}, { status: 429 }));

    expect(await newClient().client.send(readyEvent())).toMatchObject({
      status: 'retryable_failure',
      httpStatus: 429,
      errorCode: 'meta_rate_limited',
    });
  });

  it.each([
    [4, 'meta_rate_limited'],
    [17, 'meta_rate_limited'],
    [80004, 'meta_rate_limited'],
    [2, 'meta_transient_error'],
  ])(
    'treats Graph error code %i returned as HTTP 400 as retryable (%s)',
    async (code, errorCode) => {
      mockCapi(() => HttpResponse.json({ error: { code, message: 'x' } }, { status: 400 }));

      expect(await newClient().client.send(readyEvent())).toMatchObject({
        status: 'retryable_failure',
        httpStatus: 400,
        errorCode,
      });
    },
  );

  it('treats an error flagged is_transient as retryable', async () => {
    mockCapi(() =>
      HttpResponse.json({ error: { code: 100, is_transient: true } }, { status: 400 }),
    );

    expect(await newClient().client.send(readyEvent())).toMatchObject({
      status: 'retryable_failure',
      errorCode: 'meta_transient_error',
    });
  });

  it.each([
    [400, 190],
    [403, 200],
    [401, undefined],
  ])('treats HTTP %i / code %s as a permanent auth failure', async (status, code) => {
    mockCapi(() =>
      HttpResponse.json(code === undefined ? {} : { error: { code, message: 'x' } }, { status }),
    );

    expect(await newClient().client.send(readyEvent())).toMatchObject({
      status: 'permanent_failure',
      httpStatus: status,
      errorCode: 'meta_auth_error',
    });
  });

  it('never follows a redirect, so the token is not replayed to another host', async () => {
    const followed = vi.fn(() => HttpResponse.json({}));
    mockCapi(
      () =>
        new HttpResponse(null, {
          status: 307,
          headers: { location: 'https://evil.example/steal' },
        }),
    );
    server.use(http.post('https://evil.example/steal', followed));

    const result = await newClient().client.send(readyEvent());

    expect(result).toEqual({
      status: 'permanent_failure',
      httpStatus: 307,
      errorCode: 'meta_unexpected_redirect',
    });
    expect(followed).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', () => HttpResponse.text('<html>gateway</html>')],
    ['missing fbtrace_id', () => HttpResponse.json({ events_received: 1 })],
    ['wrong types', () => HttpResponse.json({ events_received: '1', fbtrace_id: 7 })],
  ])('validates a 2xx body with Zod and retries when it is unusable (%s)', async (_label, body) => {
    mockCapi(body);

    expect(await newClient().client.send(readyEvent())).toEqual({
      status: 'retryable_failure',
      httpStatus: 200,
      errorCode: 'meta_invalid_response',
    });
  });

  it('retries when Meta accepted the call but received zero events', async () => {
    mockCapi(() => HttpResponse.json({ events_received: 0, messages: [], fbtrace_id: 'trace0' }));

    expect(await newClient().client.send(readyEvent())).toMatchObject({
      status: 'retryable_failure',
      errorCode: 'meta_no_events_received',
    });
  });

  it('tolerates fields Meta may add to a successful response', async () => {
    mockCapi(() =>
      HttpResponse.json({ events_received: 1, fbtrace_id: 'trace-extra', future_field: { a: 1 } }),
    );

    expect(await newClient().client.send(readyEvent())).toMatchObject({
      status: 'sent',
      externalRef: 'trace-extra',
    });
  });

  it('treats an oversized response body as unusable instead of buffering it', async () => {
    mockCapi(() => HttpResponse.text('x'.repeat(64 * 1024)));

    expect(await newClient().client.send(readyEvent())).toMatchObject({
      status: 'retryable_failure',
      errorCode: 'meta_invalid_response',
    });
  });

  it('records one delivery.result metric per attempt with low-cardinality attributes', async () => {
    const { client, metrics } = newClient();
    mockCapi(ok);
    await client.send(readyEvent());
    mockCapi(() => HttpResponse.json({}, { status: 500 }));
    await client.send(readyEvent());

    expect(metrics.records).toEqual([
      {
        name: 'delivery.result',
        value: 1,
        attributes: { destination: 'meta_capi', result: 'sent' },
      },
      {
        name: 'delivery.result',
        value: 1,
        attributes: { destination: 'meta_capi', result: 'retryable_failure' },
      },
    ]);
  });
});
