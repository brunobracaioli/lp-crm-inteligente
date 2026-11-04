import { Writable } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConversionEvent } from '#/modules/tracking/application/ports.ts';
import { prepareServerConversion } from '#/modules/tracking/application/prepare-server-conversion.ts';
import { aLeadFacts } from '#/modules/tracking/domain/lead-facts.fixture.ts';
import {
  Ga4MeasurementProtocolClient,
  redactCollectUrl,
  type Ga4MpClientConfig,
} from '#/modules/tracking/infrastructure/ga4-mp-client.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';

const MEASUREMENT_ID = 'G-TEST12345';
// Synthetic value used to prove the secret never reaches logs; false positive for generic-api-key.
const API_SECRET = 'ga4-api-secret-for-tests-0001'; // gitleaks:allow
const COLLECT_URL = 'https://www.google-analytics.com/mp/collect';

const ENABLED: Ga4MpClientConfig = {
  enabled: true,
  measurementId: MEASUREMENT_ID,
  apiSecret: API_SECRET,
};

interface CapturedRequest {
  readonly url: URL;
  readonly body: Record<string, unknown>;
}

const server = setupServer();
const everyRequest: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', ({ request }) => {
    everyRequest.push(request.url);
  });
});
beforeEach(() => {
  everyRequest.length = 0;
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

function newClient(config: Ga4MpClientConfig, fetchImpl?: typeof fetch) {
  const logs = captureLogs();
  const metrics = createRecordingMetrics();
  const client = new Ga4MeasurementProtocolClient(config, {
    logger: logs.logger,
    metrics,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  return { client, logs, metrics };
}

function readyEvent(): ServerConversionEvent {
  const prepared = prepareServerConversion(aLeadFacts(), 'ga4_mp');
  if (prepared.kind !== 'ready') throw new Error(`event not ready: ${prepared.kind}`);
  return prepared.event;
}

function mockCollect(respond: () => Response) {
  const requests: CapturedRequest[] = [];
  server.use(
    http.post(COLLECT_URL, async ({ request }) => {
      requests.push({
        url: new URL(request.url),
        body: (await request.json()) as Record<string, unknown>,
      });
      return respond();
    }),
  );
  return requests;
}

const noContent = () => new HttpResponse(null, { status: 204 });

describe('Ga4MeasurementProtocolClient disabled (default)', () => {
  it('is disabled when configured with enabled=false and never calls Google', async () => {
    const { client } = newClient({ enabled: false });

    const result = await client.send(readyEvent());

    expect(client.enabled).toBe(false);
    expect(result).toEqual({
      status: 'permanent_failure',
      httpStatus: null,
      errorCode: 'ga4_destination_disabled',
    });
    expect(everyRequest).toEqual([]);
  });

  it('exposes the destination name used for deliveries', () => {
    expect(newClient({ enabled: false }).client.name).toBe('ga4_mp');
  });
});

describe('Ga4MeasurementProtocolClient enabled', () => {
  it('posts generate_lead with the api_secret in the query (documented exception)', async () => {
    const requests = mockCollect(noContent);
    const { client } = newClient(ENABLED);

    const result = await client.send(readyEvent());

    expect(result).toEqual({ status: 'sent', httpStatus: 204, externalRef: null });
    const [request] = requests;
    expect(request?.url.searchParams.get('measurement_id')).toBe(MEASUREMENT_ID);
    expect(request?.url.searchParams.get('api_secret')).toBe(API_SECRET);
    expect(request?.body).toMatchObject({
      timestamp_micros: 1793707200000000,
      events: [
        {
          name: 'generate_lead',
          params: {
            event_id: '3f1c9f4e-6a52-4b1d-9a53-0f6f7c1d2e11',
            lead_source: 'meta',
            score_band: 'A',
          },
        },
      ],
    });
  });

  it.each([
    ['QualifiedLead', 'qualify_lead'],
    ['Won', 'close_convert_lead'],
  ] as const)('maps %s to the GA4 recommended event %s', async (eventName, ga4Name) => {
    const requests = mockCollect(noContent);

    await newClient(ENABLED).client.send({ ...readyEvent(), eventName });

    const [event] = requests[0]?.body.events as { name: string }[];
    expect(event?.name).toBe(ga4Name);
  });

  it('uses the resolved GA client_id when available', async () => {
    const requests = mockCollect(noContent);
    const { client } = newClient({ ...ENABLED, resolveClientId: () => '1234567890.1730000000' });

    await client.send(readyEvent());

    expect(requests[0]?.body.client_id).toBe('1234567890.1730000000');
  });

  it('falls back to a pseudonymous, GA-shaped client_id different from the Meta external_id', async () => {
    const requests = mockCollect(noContent);
    const event = readyEvent();

    await newClient({ ...ENABLED, resolveClientId: () => null }).client.send(event);

    const clientId = requests[0]?.body.client_id;
    expect(clientId).toMatch(/^[0-9]{10}\.[0-9]{10}$/);
    expect(JSON.stringify(requests[0]?.body)).not.toContain(event.userData.externalId);
  });

  it('forwards no hashed or clear identifier, IP, user agent or Meta id to Google', async () => {
    const requests = mockCollect(noContent);
    const event = readyEvent();

    await newClient(ENABLED).client.send(event);

    const raw = JSON.stringify(requests[0]?.body);
    for (const hash of Object.values(event.userData)) expect(raw).not.toContain(hash);
    for (const forbidden of [
      'maria',
      'souza',
      '5511987654321',
      '203.0.113.7',
      'TestAgent',
      'fb.1.',
    ]) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('Ga4MeasurementProtocolClient failures', () => {
  it.each([
    [500, 'retryable_failure', 'ga4_unavailable'],
    [503, 'retryable_failure', 'ga4_unavailable'],
    [429, 'retryable_failure', 'ga4_unavailable'],
    [400, 'permanent_failure', 'ga4_rejected'],
    [403, 'permanent_failure', 'ga4_rejected'],
    [302, 'permanent_failure', 'ga4_rejected'],
  ] as const)('maps HTTP %i to %s (%s)', async (status, kind, errorCode) => {
    mockCollect(() => new HttpResponse(null, { status }));

    expect(await newClient(ENABLED).client.send(readyEvent())).toEqual({
      status: kind,
      httpStatus: status,
      errorCode,
    });
  });

  it('maps a network error to a retryable failure', async () => {
    mockCollect(() => HttpResponse.error());

    expect(await newClient(ENABLED).client.send(readyEvent())).toEqual({
      status: 'retryable_failure',
      httpStatus: null,
      errorCode: 'ga4_network',
    });
  });

  it('aborts after timeoutMs and reports a retryable timeout', async () => {
    vi.useFakeTimers();
    const hangingFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
    const { client } = newClient({ ...ENABLED, timeoutMs: 3_000 }, hangingFetch);

    const pending = client.send(readyEvent());
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pending).toEqual({
      status: 'retryable_failure',
      httpStatus: null,
      errorCode: 'ga4_timeout',
    });
  });

  it('never logs the api_secret: the URL is redacted in failure logs', async () => {
    mockCollect(() => new HttpResponse(null, { status: 500 }));
    const { client, logs } = newClient(ENABLED);

    await client.send(readyEvent());

    const output = logs.lines.join('');
    expect(output).toContain('conversion delivery failed');
    expect(output).toContain(MEASUREMENT_ID);
    expect(output).toContain('api_secret=');
    expect(output).not.toContain(API_SECRET);
  });

  it('records one delivery.result metric per attempt', async () => {
    mockCollect(noContent);
    const { client, metrics } = newClient(ENABLED);

    await client.send(readyEvent());

    expect(metrics.records).toEqual([
      {
        name: 'delivery.result',
        value: 1,
        attributes: { destination: 'ga4_mp', result: 'sent' },
      },
    ]);
  });
});

describe('redactCollectUrl', () => {
  it('masks the api_secret and keeps the rest', () => {
    const redacted = redactCollectUrl(
      `${COLLECT_URL}?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`,
    );

    expect(redacted).not.toContain(API_SECRET);
    expect(new URL(redacted).searchParams.get('api_secret')).toBe('[REDACTED]');
    expect(new URL(redacted).searchParams.get('measurement_id')).toBe(MEASUREMENT_ID);
  });
});

describe('Ga4MeasurementProtocolClient config', () => {
  it('rejects an enabled config with invalid fields, naming them but not their values', () => {
    const build = () =>
      newClient({ enabled: true, measurementId: 'UA-1', apiSecret: '' }, undefined).client;

    expect(build).toThrow(/measurementId, apiSecret/);
  });
});
