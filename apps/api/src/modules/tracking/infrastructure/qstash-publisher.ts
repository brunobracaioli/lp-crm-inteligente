import { Client, QstashError } from '@upstash/qstash';
import { z } from 'zod';
import type { OutboxPublisher } from '#/modules/tracking/application/ports.ts';
import type { CorrelationId, OutboxEventId } from '#/shared/ids.ts';

/**
 * Publishes `lead.captured` outbox events to QStash after COMMIT (tracking §5.1, ADR-0004).
 * QStash later calls `POST <PUBLIC_API_BASE_URL>/internal/v1/outbox/dispatch`, signed.
 *
 * - `deduplicationId = outbox_event_id`: publishing the same event twice (post-commit + sweeper)
 *   creates at most one message inside QStash's deduplication window.
 * - The correlation id travels as `X-Request-Id` (QStash forwards `Upstash-Forward-*` headers).
 * - The call is bounded by a timeout; on any failure it throws `OutboxPublishError` and the caller
 *   (the `waitUntil` wrapper) swallows it: the sweeper republishes events still `pending`.
 */

export const OUTBOX_DISPATCH_PATH = '/internal/v1/outbox/dispatch';
const DEFAULT_RETRIES = 5;
const MAX_RETRIES = 15;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const CORRELATION_HEADER = 'X-Request-Id';
const TRAILING_SLASHES = /\/+$/u;

export type OutboxPublishFailure =
  'invalid_input' | 'timeout' | 'rate_limited' | 'rejected' | 'unavailable';

/** Carries only a code and an HTTP status: never QStash's response text, URL or token. */
export class OutboxPublishError extends Error {
  readonly code: OutboxPublishFailure;
  readonly status: number | null;

  constructor(code: OutboxPublishFailure, status: number | null = null) {
    super(`outbox publish failed: ${code}`);
    this.name = 'OutboxPublishError';
    this.code = code;
    this.status = status;
  }
}

/** The slice of the `@upstash/qstash` `Client` this adapter uses (also easy to fake). */
export interface QstashPublishClient {
  publishJSON(request: {
    readonly url: string;
    readonly body: { readonly outbox_event_id: string };
    readonly deduplicationId: string;
    readonly retries: number;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<unknown>;
}

export interface QstashClientConfig {
  /** `QSTASH_URL`. */
  readonly baseUrl: string;
  /** `QSTASH_TOKEN`. */
  readonly token: string;
}

/**
 * Builds the SDK client with explicit, safe settings: no SDK-level retry (the sweeper is the retry
 * mechanism and `deduplicationId` makes repeats harmless), no telemetry and no local dev server.
 */
export function createQstashClient(config: QstashClientConfig): Client {
  return new Client({
    baseUrl: config.baseUrl,
    token: config.token,
    retry: false,
    enableTelemetry: false,
    devMode: false,
  });
}

export interface QstashOutboxPublisherConfig {
  readonly client: QstashPublishClient;
  /** `PUBLIC_API_BASE_URL`, e.g. `https://api.example.com` (no query, no credentials). */
  readonly publicApiBaseUrl: string;
  /** QStash delivery retries for the dispatch call. Defaults to 5 (tracking §5.1). */
  readonly retries?: number | undefined;
  /** Bound on the publish call itself. Defaults to 5 s. */
  readonly timeoutMs?: number | undefined;
}

const outboxEventIdSchema = z.uuid();
const settingsSchema = z
  .object({
    retries: z.number().int().min(0).max(MAX_RETRIES),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS),
  })
  .strict();

function resolveDispatchUrl(publicApiBaseUrl: string): string {
  let base: URL;
  try {
    base = new URL(publicApiBaseUrl);
  } catch {
    throw new Error('Invalid QStash publisher config: publicApiBaseUrl');
  }
  const plain =
    (base.protocol === 'https:' || base.protocol === 'http:') &&
    base.username === '' &&
    base.password === '' &&
    base.search === '' &&
    base.hash === '';
  if (!plain) {
    throw new Error('Invalid QStash publisher config: publicApiBaseUrl');
  }
  return `${base.origin}${base.pathname.replace(TRAILING_SLASHES, '')}${OUTBOX_DISPATCH_PATH}`;
}

function toPublishError(error: unknown): OutboxPublishError {
  if (error instanceof OutboxPublishError) return error;
  if (error instanceof QstashError && error.status !== undefined) {
    if (error.status === 429) return new OutboxPublishError('rate_limited', error.status);
    if (error.status >= 400 && error.status < 500) {
      return new OutboxPublishError('rejected', error.status);
    }
    return new OutboxPublishError('unavailable', error.status);
  }
  return new OutboxPublishError('unavailable');
}

export class QstashOutboxPublisher implements OutboxPublisher {
  /** Exact URL QStash calls; the `sub` claim of its signature equals this value. */
  readonly dispatchUrl: string;

  private readonly client: QstashPublishClient;
  private readonly retries: number;
  private readonly timeoutMs: number;

  constructor(config: QstashOutboxPublisherConfig) {
    const settings = settingsSchema.safeParse({
      retries: config.retries ?? DEFAULT_RETRIES,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!settings.success) {
      const fields = settings.error.issues.map((issue) => issue.path.join('.'));
      throw new Error(`Invalid QStash publisher config: ${fields.join(', ')}`);
    }
    this.dispatchUrl = resolveDispatchUrl(config.publicApiBaseUrl);
    this.client = config.client;
    this.retries = settings.data.retries;
    this.timeoutMs = settings.data.timeoutMs;
  }

  async publish(
    outboxEventId: OutboxEventId,
    options: { readonly correlationId: CorrelationId },
  ): Promise<void> {
    if (!outboxEventIdSchema.safeParse(outboxEventId).success) {
      throw new OutboxPublishError('invalid_input');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new OutboxPublishError('timeout'));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([
        this.client.publishJSON({
          url: this.dispatchUrl,
          body: { outbox_event_id: outboxEventId },
          deduplicationId: outboxEventId,
          retries: this.retries,
          headers: { [CORRELATION_HEADER]: options.correlationId },
        }),
        timeout,
      ]);
    } catch (error) {
      throw toPublishError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}
