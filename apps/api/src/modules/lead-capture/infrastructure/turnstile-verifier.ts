import { z } from 'zod';
import type {
  AntiBotFailureReason,
  AntiBotVerification,
  AntiBotVerificationRequest,
  AntiBotVerifier,
  Clock,
} from '#/modules/lead-capture/application/ports.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';

/** Cloudflare Turnstile server-side validation endpoint. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Outbound timeout (000-overview §5.4). Exceeding it is "unavailable", never "passed". */
export const TURNSTILE_TIMEOUT_MS = 3_000;

/** lead-capture §6: a token older than this is rejected even when Cloudflare still accepts it. */
export const TURNSTILE_MAX_CHALLENGE_AGE_SECONDS = 300;

const MS_PER_SECOND = 1_000;

/**
 * siteverify response. Consumed fields are validated strictly (type and shape), but unknown keys
 * are tolerated on purpose: this is a fail-closed dependency (ADR-0005), so a new field added by
 * Cloudflare must not turn into a full outage of the public endpoint. `.strict()` stays the rule
 * for inbound client payloads.
 */
const siteverifyResponseSchema = z.looseObject({
  success: z.boolean(),
  'error-codes': z.array(z.string().max(64)).max(32).default([]),
  challenge_ts: z.string().max(64).optional(),
  hostname: z.string().max(253).optional(),
  action: z.string().max(128).optional(),
  metadata: z.looseObject({ ephemeral_id: z.string().max(128).optional() }).optional(),
});

type SiteverifyResponse = z.infer<typeof siteverifyResponseSchema>;

/** Error codes that mean OUR request is wrong (secret/config/Cloudflare side), not the visitor. */
const SERVICE_ERROR_CODES: ReadonlySet<string> = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'internal-error',
]);

export type TurnstileFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TurnstileVerifierOptions {
  /** `TURNSTILE_SECRET_KEY`. Only ever placed in the POST body. */
  readonly secretKey: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Defaults to the global `fetch`; injectable for tests. */
  readonly fetch?: TurnstileFetch;
  readonly timeoutMs?: number;
  readonly maxChallengeAgeSeconds?: number;
}

type UnavailableCause =
  'timeout' | 'network' | 'http_status' | 'invalid_response' | 'service_error';

/**
 * Turnstile adapter for the `AntiBotVerifier` port (lead-capture §2 step 6, §6).
 * Fail-closed: any condition that prevents a trustworthy answer resolves to `unavailable`.
 */
export function createTurnstileVerifier(options: TurnstileVerifierOptions): AntiBotVerifier {
  const doFetch: TurnstileFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? TURNSTILE_TIMEOUT_MS;
  const maxAgeSeconds = options.maxChallengeAgeSeconds ?? TURNSTILE_MAX_CHALLENGE_AGE_SECONDS;

  const unavailable = (cause: UnavailableCause, status?: number): AntiBotVerification => {
    // A rejected secret is an operator problem (page someone); the rest is third-party flakiness.
    options.logger[cause === 'service_error' ? 'error' : 'warn'](
      { cause, ...(status === undefined ? {} : { http_status: status }) },
      'turnstile verification unavailable',
    );
    options.metrics.record('antibot.failures', 1, { reason: 'unavailable' });
    return { outcome: 'unavailable' };
  };

  const failed = (reason: AntiBotFailureReason): AntiBotVerification => {
    options.metrics.record('antibot.failures', 1, { reason });
    return { outcome: 'failed', reason };
  };

  return {
    async verify(request: AntiBotVerificationRequest): Promise<AntiBotVerification> {
      const fetched = await postSiteverify(doFetch, options.secretKey, request, timeoutMs);
      if (fetched.kind === 'error') return unavailable(fetched.cause, fetched.status);

      const body = fetched.body;
      if (!body.success) {
        const reason = failureReasonFor(body['error-codes']);
        return reason === 'service_error' ? unavailable('service_error') : failed(reason);
      }
      return evaluateChallenge(body, request, options.clock, maxAgeSeconds, failed);
    },
  };
}

type FetchOutcome =
  | { readonly kind: 'ok'; readonly body: SiteverifyResponse }
  | { readonly kind: 'error'; readonly cause: UnavailableCause; readonly status?: number };

async function postSiteverify(
  doFetch: TurnstileFetch,
  secretKey: string,
  request: AntiBotVerificationRequest,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  // Not AbortSignal.timeout(): a plain timer can be driven by fake timers in tests.
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await doFetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        secret: secretKey,
        response: request.token,
        idempotency_key: request.idempotencyKey,
        ...(request.remoteIp === null ? {} : { remoteip: request.remoteIp }),
      }),
      // A redirect would replay the secret to another location.
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return { kind: 'error', cause: 'http_status', status: response.status };

    const parsed = siteverifyResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { kind: 'ok', body: parsed.data }
      : { kind: 'error', cause: 'invalid_response' };
  } catch (error) {
    if (controller.signal.aborted) return { kind: 'error', cause: 'timeout' };
    return {
      kind: 'error',
      cause: error instanceof SyntaxError ? 'invalid_response' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

function failureReasonFor(errorCodes: readonly string[]): AntiBotFailureReason | 'service_error' {
  if (errorCodes.some((code) => SERVICE_ERROR_CODES.has(code))) return 'service_error';
  if (errorCodes.includes('timeout-or-duplicate')) return 'token_reused';
  // invalid-input-response, missing-input-response, bad-request and unknown codes.
  return 'invalid_token';
}

function evaluateChallenge(
  body: SiteverifyResponse,
  request: AntiBotVerificationRequest,
  clock: Clock,
  maxAgeSeconds: number,
  failed: (reason: AntiBotFailureReason) => AntiBotVerification,
): AntiBotVerification {
  const hostname = body.hostname?.toLowerCase();
  const allowedHostnames = request.expectedHostnames.map((host) => host.toLowerCase());
  if (hostname === undefined || !allowedHostnames.includes(hostname)) {
    return failed('hostname_mismatch');
  }
  if (body.action !== request.expectedAction) return failed('action_mismatch');

  const challengeTime =
    body.challenge_ts === undefined ? Number.NaN : Date.parse(body.challenge_ts);
  if (Number.isNaN(challengeTime)) return failed('stale_challenge');

  // A timestamp slightly ahead of our clock is skew, not a reason to reject.
  const ageMs = Math.max(0, clock.now().getTime() - challengeTime);
  if (ageMs > maxAgeSeconds * MS_PER_SECOND) return failed('stale_challenge');

  return {
    outcome: 'passed',
    challengeAgeSeconds: Math.floor(ageMs / MS_PER_SECOND),
    ephemeralId: body.metadata?.ephemeral_id ?? null,
  };
}
