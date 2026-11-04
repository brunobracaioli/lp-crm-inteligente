import { z } from 'zod';
import type {
  ConversionDestination,
  DeliveryAttemptResult,
  ServerConversionEvent,
} from '#/modules/tracking/application/ports.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';

/**
 * GA4 Measurement Protocol adapter (tracking §5.3). OFF by default: the client-side
 * `generate_lead` is the source of truth, and turning this on must also move the client-side event
 * to server-only, otherwise GA4 double-counts (it does not deduplicate).
 *
 * Security notes:
 * - Google requires `api_secret` in the query string (documented exception, threat model §T13):
 *   it is a server-to-server call and the URL is never logged unredacted (see `redactCollectUrl`).
 * - Only the GA4 `client_id`, event name and code-only parameters are sent. The hashed identifiers
 *   of the event are deliberately NOT forwarded to Google.
 * - GA4 answers 2xx with an empty body whether or not the payload is valid (validation exists only
 *   on the separate debug endpoint), so there is no response to parse: any 2xx counts as `sent`.
 */

const COLLECT_ORIGIN = 'https://www.google-analytics.com';
const COLLECT_PATH = '/mp/collect';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MICROS_PER_MILLISECOND = 1_000;
const REDACTED = '[REDACTED]';
const HASH_PREFIX_PATTERN = /^[0-9a-f]{16}/u;
const GA_CLIENT_ID_HEAD_LENGTH = 10;
const GA_CLIENT_ID_TOTAL_LENGTH = 20;

/** GA4 recommended lead events for the conversions this system reports. */
const GA4_EVENT_NAMES: Readonly<Record<ServerConversionEvent['eventName'], string>> = {
  Lead: 'generate_lead',
  QualifiedLead: 'qualify_lead',
  Won: 'close_convert_lead',
};

export type Ga4MpClientConfig =
  /** Default: no request is ever made. */
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      /** `GA4_MEASUREMENT_ID`, e.g. `G-ABC123`. */
      readonly measurementId: string;
      /** `GA4_API_SECRET`. */
      readonly apiSecret: string;
      readonly timeoutMs?: number | undefined;
      /**
       * Resolves the browser's GA `client_id` (the `_ga` cookie, `<digits>.<digits>`) for an event.
       * Without it, or when it returns null, a pseudonymous id derived one-way from the hashed
       * external id is used: events are counted but cannot be joined to the browser session.
       */
      readonly resolveClientId?: ((event: ServerConversionEvent) => string | null) | undefined;
    };

export interface Ga4MpClientDeps {
  readonly logger: Logger;
  readonly metrics?: Metrics | undefined;
  /** Test hook; defaults to the global `fetch` resolved at call time. */
  readonly fetch?: typeof fetch | undefined;
}

const enabledConfigSchema = z
  .object({
    enabled: z.literal(true),
    measurementId: z.string().regex(/^G-[A-Z0-9]{4,20}$/u),
    apiSecret: z.string().min(1),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  })
  .strict();

type FailureKind = 'retryable_failure' | 'permanent_failure';

function failure(
  kind: FailureKind,
  httpStatus: number | null,
  errorCode: string,
): DeliveryAttemptResult {
  return { status: kind, httpStatus, errorCode };
}

class TransportError extends Error {
  readonly kind: 'timeout' | 'network';

  constructor(kind: 'timeout' | 'network') {
    super(`ga4 transport failure: ${kind}`);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

/**
 * Fallback `client_id` in GA's `<number>.<number>` shape, derived one-way from the hashed external
 * id. It is a different value from the `external_id` sent to Meta, so the two platforms cannot be
 * joined on it. Returns null if the hash is not hex (cannot happen for `HashedUserData`).
 */
function pseudonymousClientId(hashedExternalId: string): string | null {
  const prefix = HASH_PREFIX_PATTERN.exec(hashedExternalId)?.[0];
  if (prefix === undefined) return null;
  const padded = BigInt(`0x${prefix}`).toString().padStart(GA_CLIENT_ID_TOTAL_LENGTH, '0');
  return `${padded.slice(0, GA_CLIENT_ID_HEAD_LENGTH)}.${padded.slice(GA_CLIENT_ID_HEAD_LENGTH)}`;
}

/** The collect URL with the secret masked; the only form of it that may reach a log. */
export function redactCollectUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has('api_secret')) {
    parsed.searchParams.set('api_secret', REDACTED);
  }
  return parsed.toString();
}

export class Ga4MeasurementProtocolClient implements ConversionDestination {
  readonly name = 'ga4_mp' as const;
  /** Wiring checks this to record `skipped_disabled` instead of calling `send`. */
  readonly enabled: boolean;

  private readonly collectUrl: string | null;
  private readonly timeoutMs: number;
  private readonly resolveClientId: (event: ServerConversionEvent) => string | null;
  private readonly deps: Ga4MpClientDeps;

  constructor(config: Ga4MpClientConfig, deps: Ga4MpClientDeps) {
    this.deps = deps;
    if (!config.enabled) {
      this.enabled = false;
      this.collectUrl = null;
      this.timeoutMs = DEFAULT_TIMEOUT_MS;
      this.resolveClientId = () => null;
      return;
    }
    const parsed = enabledConfigSchema.safeParse({
      enabled: config.enabled,
      measurementId: config.measurementId,
      apiSecret: config.apiSecret,
      timeoutMs: config.timeoutMs,
    });
    if (!parsed.success) {
      // Names the offending fields only: never echo configuration values (the secret is one).
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
      throw new Error(`Invalid GA4 Measurement Protocol client config: ${fields.join(', ')}`);
    }
    const query = new URLSearchParams({
      measurement_id: parsed.data.measurementId,
      api_secret: parsed.data.apiSecret,
    });
    this.enabled = true;
    this.collectUrl = `${COLLECT_ORIGIN}${COLLECT_PATH}?${query.toString()}`;
    this.timeoutMs = parsed.data.timeoutMs;
    this.resolveClientId = config.resolveClientId ?? (() => null);
  }

  async send(event: ServerConversionEvent): Promise<DeliveryAttemptResult> {
    const result = await this.attempt(event);
    this.deps.metrics?.record('delivery.result', 1, {
      destination: this.name,
      result: result.status,
    });
    if (result.status !== 'sent' && this.collectUrl !== null) {
      this.deps.logger.warn(
        {
          destination: this.name,
          event_id: event.eventId,
          result: result.status,
          http_status: result.httpStatus,
          error_code: result.errorCode,
          url: redactCollectUrl(this.collectUrl),
        },
        'conversion delivery failed',
      );
    }
    return result;
  }

  private async attempt(event: ServerConversionEvent): Promise<DeliveryAttemptResult> {
    if (this.collectUrl === null) {
      // The caller should have recorded `skipped_disabled`; never reach Google when disabled.
      return failure('permanent_failure', null, 'ga4_destination_disabled');
    }
    const clientId = this.resolveClientId(event) ?? pseudonymousClientId(event.userData.externalId);
    if (clientId === null) {
      return failure('permanent_failure', null, 'ga4_missing_client_id');
    }
    let status: number;
    try {
      const body = JSON.stringify(this.buildRequestBody(event, clientId));
      status = await this.post(this.collectUrl, body);
    } catch (error) {
      if (error instanceof TransportError) {
        return failure('retryable_failure', null, `ga4_${error.kind}`);
      }
      throw error;
    }
    if (status >= 200 && status < 300) {
      return { status: 'sent', httpStatus: status, externalRef: null };
    }
    if (status === 408 || status === 429 || status >= 500) {
      return failure('retryable_failure', status, 'ga4_unavailable');
    }
    return failure('permanent_failure', status, 'ga4_rejected');
  }

  private buildRequestBody(
    event: ServerConversionEvent,
    clientId: string,
  ): Record<string, unknown> {
    return {
      client_id: clientId,
      timestamp_micros: event.eventTime.getTime() * MICROS_PER_MILLISECOND,
      events: [
        {
          name: GA4_EVENT_NAMES[event.eventName],
          params: { ...event.customData, event_id: event.eventId },
        },
      ],
    };
  }

  private async post(url: string, body: string): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const doFetch = this.deps.fetch ?? globalThis.fetch;
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      // The body is empty and irrelevant; release the connection without reading it.
      await response.body?.cancel();
      return response.status;
    } catch {
      throw new TransportError(controller.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}
