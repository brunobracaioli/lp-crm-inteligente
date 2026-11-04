import { z } from 'zod';
import type {
  ConversionDestination,
  DeliveryAttemptResult,
  ServerConversionEvent,
} from '#/modules/tracking/application/ports.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';

/**
 * Meta Conversions API adapter (tracking §5.2). One `POST` per conversion to
 * `https://graph.facebook.com/<version>/<pixel_id>/events`.
 *
 * Security notes:
 * - `access_token` travels in the JSON body, never in the URL (the Graph API accepts it as a POST
 *   parameter; Meta's own sample sends it as a form field). Nothing in this file logs the body, the
 *   token or Meta's response text.
 * - Redirects are never followed: a 307/308 would replay the body, token included, to a new host.
 * - Hashed identifiers are expected already hashed (see `application/prepare-server-conversion`).
 */

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface MetaCapiClientConfig {
  readonly pixelId: string;
  readonly accessToken: string;
  /** E.g. `v25.0` (`META_GRAPH_API_VERSION`). */
  readonly graphApiVersion: string;
  /** Sent as `test_event_code` only when set (`META_TEST_EVENT_CODE`, never in production). */
  readonly testEventCode?: string | undefined;
  /** Defaults to 5 s (tracking §5.2). */
  readonly timeoutMs?: number | undefined;
}

export interface MetaCapiClientDeps {
  readonly logger: Logger;
  readonly metrics?: Metrics | undefined;
  /** Test hook; defaults to the global `fetch` resolved at call time. */
  readonly fetch?: typeof fetch | undefined;
}

// Values are validated before they are interpolated into the request path.
const configSchema = z
  .object({
    pixelId: z.string().regex(/^[0-9]{5,20}$/u),
    accessToken: z.string().min(1),
    graphApiVersion: z.string().regex(/^v[0-9]{1,3}\.[0-9]$/u),
    testEventCode: z
      .string()
      .regex(/^TEST[0-9A-Za-z]{1,20}$/u)
      .optional(),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  })
  .strict();

// Third-party responses are validated but not `.strict()`: a field Meta adds to a 2xx body must not
// turn a delivered event into a false failure (and a pointless retry/dead letter).
const successSchema = z.object({
  events_received: z.number().int().nonnegative(),
  messages: z.array(z.string()).optional(),
  fbtrace_id: z.string().min(1).max(128),
});

const errorSchema = z.object({
  error: z.object({
    code: z.number().int().optional(),
    is_transient: z.boolean().optional(),
    fbtrace_id: z.string().max(128).optional(),
  }),
});

// Graph API error codes (https://developers.facebook.com/docs/graph-api/guides/error-handling,
// accessed 2026-11-03). Documented there: 1, 2 (temporary), 4, 17, 341 (throttling), 10, 102, 190,
// 200-299 (permissions/token). 32, 613 and 80000-80014 are the Marketing API rate-limit codes.
const TRANSIENT_CODES: ReadonlySet<number> = new Set([1, 2]);
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 341, 613]);
const AUTH_CODES: ReadonlySet<number> = new Set([10, 102, 190]);
const BUC_RATE_LIMIT_RANGE = { min: 80_000, max: 80_014 } as const;
const PERMISSION_RANGE = { min: 200, max: 299 } as const;

type FailureKind = 'retryable_failure' | 'permanent_failure';
type TransportFailure = 'timeout' | 'network';

interface Attempt {
  readonly result: DeliveryAttemptResult;
  /** Logged on failures to open Meta support cases; not PII. */
  readonly fbtraceId: string | null;
}

class TransportError extends Error {
  readonly kind: TransportFailure;

  constructor(kind: TransportFailure) {
    super(`meta capi transport failure: ${kind}`);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

function inRange(value: number, range: { readonly min: number; readonly max: number }): boolean {
  return value >= range.min && value <= range.max;
}

function failure(
  kind: FailureKind,
  httpStatus: number | null,
  errorCode: string,
  fbtraceId: string | null = null,
): Attempt {
  return { result: { status: kind, httpStatus, errorCode }, fbtraceId };
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Chunk shape of `ReadableStreamDefaultReader<Uint8Array>.read()` (Node's typings leave it `any`). */
type ReadChunk =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };

/** Reads at most `maxBytes` of the body; `null` means the response was larger. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as ReadChunk;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class MetaCapiClient implements ConversionDestination {
  readonly name = 'meta_capi' as const;

  private readonly url: string;
  private readonly accessToken: string;
  private readonly testEventCode: string | undefined;
  private readonly timeoutMs: number;
  private readonly deps: MetaCapiClientDeps;

  constructor(config: MetaCapiClientConfig, deps: MetaCapiClientDeps) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      // Names the offending fields only: never echo configuration values (the token is one).
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
      throw new Error(`Invalid Meta CAPI client config: ${fields.join(', ')}`);
    }
    this.url = `${GRAPH_ORIGIN}/${parsed.data.graphApiVersion}/${parsed.data.pixelId}/events`;
    this.accessToken = parsed.data.accessToken;
    this.testEventCode = parsed.data.testEventCode;
    this.timeoutMs = parsed.data.timeoutMs;
    this.deps = deps;
  }

  async send(event: ServerConversionEvent): Promise<DeliveryAttemptResult> {
    const { result, fbtraceId } = await this.attempt(event);
    this.deps.metrics?.record('delivery.result', 1, {
      destination: this.name,
      result: result.status,
    });
    if (result.status !== 'sent') {
      // Codes and ids only: no body, no token, no PII.
      this.deps.logger.warn(
        {
          destination: this.name,
          event_id: event.eventId,
          result: result.status,
          http_status: result.httpStatus,
          error_code: result.errorCode,
          fbtrace_id: fbtraceId,
        },
        'conversion delivery failed',
      );
    }
    return result;
  }

  private async attempt(event: ServerConversionEvent): Promise<Attempt> {
    let response: { readonly status: number; readonly text: string | null };
    try {
      response = await this.post(JSON.stringify(this.buildRequestBody(event)));
    } catch (error) {
      if (error instanceof TransportError) {
        return failure('retryable_failure', null, `meta_${error.kind}`);
      }
      throw error;
    }
    return this.interpret(response.status, parseJson(response.text));
  }

  private buildRequestBody(event: ServerConversionEvent): Record<string, unknown> {
    const userData: Record<string, string | readonly string[]> = {
      em: [event.userData.em],
      ph: [event.userData.ph],
      fn: [event.userData.fn],
      ln: [event.userData.ln],
      external_id: [event.userData.externalId],
    };
    // IP, user agent, fbp and fbc are sent in clear: Meta requires them unhashed.
    if (event.clientIpAddress !== null) userData.client_ip_address = event.clientIpAddress;
    if (event.clientUserAgent !== null) userData.client_user_agent = event.clientUserAgent;
    if (event.fbp !== null) userData.fbp = event.fbp;
    if (event.fbc !== null) userData.fbc = event.fbc;

    return {
      data: [
        {
          event_name: event.eventName,
          event_time: Math.floor(event.eventTime.getTime() / 1000),
          event_id: event.eventId,
          action_source: event.actionSource,
          ...(event.eventSourceUrl === null ? {} : { event_source_url: event.eventSourceUrl }),
          user_data: userData,
          custom_data: event.customData,
        },
      ],
      ...(this.testEventCode === undefined ? {} : { test_event_code: this.testEventCode }),
      access_token: this.accessToken,
    };
  }

  /** POSTs the body; the timeout covers connecting, headers and reading the (bounded) response. */
  private async post(
    body: string,
  ): Promise<{ readonly status: number; readonly text: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const doFetch = this.deps.fetch ?? globalThis.fetch;
      const response = await doFetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      return { status: response.status, text };
    } catch {
      throw new TransportError(controller.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  private interpret(status: number, json: unknown): Attempt {
    if (status >= 300 && status < 400) {
      return failure('permanent_failure', status, 'meta_unexpected_redirect');
    }
    if (status >= 200 && status < 300) {
      return this.interpretSuccess(status, json);
    }
    return this.interpretError(status, json);
  }

  private interpretSuccess(status: number, json: unknown): Attempt {
    const parsed = successSchema.safeParse(json);
    if (!parsed.success) {
      // Accepted by Meta but unverifiable: retry is safe, Meta deduplicates on event_id.
      return failure('retryable_failure', status, 'meta_invalid_response');
    }
    if (parsed.data.events_received < 1) {
      return failure(
        'retryable_failure',
        status,
        'meta_no_events_received',
        parsed.data.fbtrace_id,
      );
    }
    return {
      result: { status: 'sent', httpStatus: status, externalRef: parsed.data.fbtrace_id },
      fbtraceId: parsed.data.fbtrace_id,
    };
  }

  /**
   * Meta also reports throttling and temporary outages as HTTP 400 with a Graph error `code`, so
   * the code is consulted before treating a 4xx as a permanent validation failure.
   */
  private interpretError(status: number, json: unknown): Attempt {
    const parsed = errorSchema.safeParse(json);
    const code = parsed.success ? parsed.data.error.code : undefined;
    const fbtraceId = parsed.success ? (parsed.data.error.fbtrace_id ?? null) : null;
    const transient = parsed.success && parsed.data.error.is_transient === true;

    if (
      status === 429 ||
      (code !== undefined && (RATE_LIMIT_CODES.has(code) || inRange(code, BUC_RATE_LIMIT_RANGE)))
    ) {
      return failure('retryable_failure', status, 'meta_rate_limited', fbtraceId);
    }
    if (status >= 500) {
      return failure('retryable_failure', status, 'meta_server_error', fbtraceId);
    }
    if (status === 408 || transient || (code !== undefined && TRANSIENT_CODES.has(code))) {
      return failure('retryable_failure', status, 'meta_transient_error', fbtraceId);
    }
    if (
      status === 401 ||
      status === 403 ||
      (code !== undefined && (AUTH_CODES.has(code) || inRange(code, PERMISSION_RANGE)))
    ) {
      return failure('permanent_failure', status, 'meta_auth_error', fbtraceId);
    }
    return failure('permanent_failure', status, 'meta_rejected', fbtraceId);
  }
}
