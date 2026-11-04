import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_DISPATCH_PATH,
  OutboxPublishError,
  QstashOutboxPublisher,
  createQstashClient,
  type QstashPublishClient,
} from '#/modules/tracking/infrastructure/qstash-publisher.ts';
import type { CorrelationId, OutboxEventId } from '#/shared/ids.ts';

const QSTASH_URL = 'https://qstash.example.test';
const QSTASH_TOKEN = 'qstash-token-for-tests-0001';
const API_BASE_URL = 'https://api.example.test';
const DISPATCH_URL = `${API_BASE_URL}${OUTBOX_DISPATCH_PATH}`;
const OUTBOX_EVENT_ID = '0192f3a0-1111-7222-8333-444455556666' as OutboxEventId;
const CORRELATION_ID = 'c0ffee00-1111-4222-8333-444455556666' as CorrelationId;

interface PublishedMessage {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
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

function mockQstash(respond: () => Response) {
  const messages: PublishedMessage[] = [];
  server.use(
    http.post(`${QSTASH_URL}/v2/publish/*`, async ({ request }) => {
      messages.push({
        url: request.url,
        headers: request.headers,
        body: await request.json(),
      });
      return respond();
    }),
  );
  return messages;
}

function sdkPublisher(overrides: { timeoutMs?: number; retries?: number } = {}) {
  return new QstashOutboxPublisher({
    // Type-checks that the real SDK `Client` satisfies the adapter's `QstashPublishClient`.
    client: createQstashClient({ baseUrl: QSTASH_URL, token: QSTASH_TOKEN }),
    publicApiBaseUrl: API_BASE_URL,
    ...overrides,
  });
}

const accepted = () => HttpResponse.json({ messageId: 'msg_123', url: DISPATCH_URL });

describe('QstashOutboxPublisher against the QStash REST API (MSW)', () => {
  it('publishes the outbox event id with deduplication id, retries and correlation header', async () => {
    const messages = mockQstash(accepted);

    await sdkPublisher().publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID });

    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.url).toBe(`${QSTASH_URL}/v2/publish/${DISPATCH_URL}`);
    expect(message?.body).toEqual({ outbox_event_id: OUTBOX_EVENT_ID });
    expect(message?.headers.get('upstash-deduplication-id')).toBe(OUTBOX_EVENT_ID);
    expect(message?.headers.get('upstash-retries')).toBe('5');
    expect(message?.headers.get('upstash-method')).toBe('POST');
    expect(message?.headers.get('content-type')).toBe('application/json');
    expect(message?.headers.get('upstash-forward-x-request-id')).toBe(CORRELATION_ID);
    expect(message?.headers.get('authorization')).toBe(`Bearer ${QSTASH_TOKEN}`);
  });

  it('keeps the QStash token out of the URL and the payload', async () => {
    const messages = mockQstash(accepted);

    await sdkPublisher().publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID });

    expect(messages[0]?.url).not.toContain(QSTASH_TOKEN);
    expect(JSON.stringify(messages[0]?.body)).not.toContain(QSTASH_TOKEN);
  });

  it('honors configured retries', async () => {
    const messages = mockQstash(accepted);

    await sdkPublisher({ retries: 2 }).publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID });

    expect(messages[0]?.headers.get('upstash-retries')).toBe('2');
  });

  it('treats a deduplicated publish as success', async () => {
    mockQstash(() => HttpResponse.json({ messageId: 'msg_123', deduplicated: true }));

    await expect(
      sdkPublisher().publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID }),
    ).resolves.toBeUndefined();
  });

  it.each([
    [401, 'rejected'],
    [400, 'rejected'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ] as const)(
    'maps QStash HTTP %i to OutboxPublishError(%s) without echoing its body',
    async (status, code) => {
      mockQstash(() => HttpResponse.text(`secret detail ${QSTASH_TOKEN}`, { status }));
      // The SDK writes its own one-line console.error on failure; capture it to check it too.
      const sdkLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const failure = await sdkPublisher()
        .publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OutboxPublishError);
      expect(failure).toMatchObject({ code, status });
      const { message } = failure as OutboxPublishError;
      expect(message).not.toContain(QSTASH_TOKEN);
      expect(message).not.toContain('secret detail');
      const sdkOutput = sdkLog.mock.calls.flat().join(' ');
      expect(sdkOutput).not.toContain(QSTASH_TOKEN);
      expect(sdkOutput).not.toContain('secret detail');
    },
  );

  it('maps a network failure to unavailable', async () => {
    mockQstash(() => HttpResponse.error());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      sdkPublisher().publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID }),
    ).rejects.toMatchObject({ code: 'unavailable', status: null });
  });
});

describe('QstashOutboxPublisher timeout and validation', () => {
  function fakeClient(publishJSON: QstashPublishClient['publishJSON']): QstashPublishClient {
    return { publishJSON };
  }

  it('fails with timeout when QStash does not answer within timeoutMs', async () => {
    vi.useFakeTimers();
    const publisher = new QstashOutboxPublisher({
      client: fakeClient(() => new Promise<never>(() => undefined)),
      publicApiBaseUrl: API_BASE_URL,
      timeoutMs: 5_000,
    });

    const outcome = publisher
      .publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toMatchObject({ code: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer after a fast success', async () => {
    vi.useFakeTimers();
    const publisher = new QstashOutboxPublisher({
      client: fakeClient(() => Promise.resolve({ messageId: 'msg_1' })),
      publicApiBaseUrl: API_BASE_URL,
    });

    await publisher.publish(OUTBOX_EVENT_ID, { correlationId: CORRELATION_ID });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a malformed outbox event id before calling QStash', async () => {
    const publishJSON = vi.fn<QstashPublishClient['publishJSON']>();
    const publisher = new QstashOutboxPublisher({
      client: fakeClient(publishJSON),
      publicApiBaseUrl: API_BASE_URL,
    });

    await expect(
      publisher.publish('not-a-uuid' as OutboxEventId, { correlationId: CORRELATION_ID }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(publishJSON).not.toHaveBeenCalled();
  });

  it('builds the dispatch URL from the base URL, tolerating a trailing slash or path prefix', () => {
    const urlFor = (publicApiBaseUrl: string) =>
      new QstashOutboxPublisher({
        client: fakeClient(() => Promise.resolve()),
        publicApiBaseUrl,
      }).dispatchUrl;

    expect(urlFor('https://api.example.test')).toBe(DISPATCH_URL);
    expect(urlFor('https://api.example.test/')).toBe(DISPATCH_URL);
    expect(urlFor('https://api.example.test/edge/')).toBe(
      `https://api.example.test/edge${OUTBOX_DISPATCH_PATH}`,
    );
  });

  it.each([
    'not a url',
    'ftp://api.example.test',
    'https://user:pass@api.example.test',
    'https://api.example.test/?token=1',
    'https://api.example.test/#frag',
  ])('rejects the invalid base URL %j', (publicApiBaseUrl) => {
    expect(
      () =>
        new QstashOutboxPublisher({
          client: fakeClient(() => Promise.resolve()),
          publicApiBaseUrl,
        }),
    ).toThrow(/publicApiBaseUrl/);
  });

  it('rejects out-of-range retries and timeout', () => {
    const build = (overrides: { retries?: number; timeoutMs?: number }) => () =>
      new QstashOutboxPublisher({
        client: fakeClient(() => Promise.resolve()),
        publicApiBaseUrl: API_BASE_URL,
        ...overrides,
      });

    expect(build({ retries: -1 })).toThrow(/retries/);
    expect(build({ retries: 99 })).toThrow(/retries/);
    expect(build({ timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});
