import { Hono, type Context } from 'hono';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { HttpProblem, problemResponse, type ProblemCode } from '#/platform/errors/problem.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import { resolveClientIp, type ClientIpOptions } from '#/platform/net/client-ip.ts';
import type {
  SubmitLead,
  SubmitLeadAccepted,
  SubmitLeadCommand,
  SubmitLeadFailure,
} from '#/modules/lead-capture/application/submit-lead.ts';
import { parseIdempotencyKey } from '#/modules/lead-capture/domain/idempotency.ts';
import { failureToProblem } from '#/modules/lead-capture/presentation/failure-mapping.ts';

export interface LeadCaptureRoutesDependencies {
  readonly submitLead: SubmitLead;
  readonly metrics: Metrics;
  /** `trustVercelProxy` is true only on Vercel deployments; elsewhere the client IP stays unknown. */
  readonly clientIp: ClientIpOptions;
}

const JSON_MEDIA_TYPE = 'application/json';
const UTF8_CHARSET_PARAMETERS: ReadonlySet<string> = new Set(['charset=utf-8', 'charset="utf-8"']);

/** How one request ended; drives the response, the metrics and the log line. */
type Handled =
  | { readonly kind: 'accepted'; readonly result: SubmitLeadAccepted }
  | {
      readonly kind: 'rejected';
      readonly problem: HttpProblem;
      /** Present when the use case refused; absent when a transport guard did. */
      readonly failure: SubmitLeadFailure | undefined;
    };

/** `Content-Type` must be `application/json`, optionally with `charset=utf-8` (lead-capture §3). */
function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [mediaType, ...parameters] = header.split(';').map((part) => part.trim().toLowerCase());
  return mediaType === JSON_MEDIA_TYPE && parameters.every((p) => UTF8_CHARSET_PARAMETERS.has(p));
}

/** Malformed JSON is `400 invalid_json`; the parser message (which could echo input) is dropped. */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpProblem(400, 'invalid_json');
  }
}

/**
 * Transport guards (spec §2, step 3) and command assembly. Throws `HttpProblem` for guard
 * failures. Body schema, Origin vs form and every other rule belong to the use case.
 */
async function readCommand(
  c: Context<AppEnv>,
  clientIpOptions: ClientIpOptions,
): Promise<SubmitLeadCommand> {
  if (!isJsonContentType(c.req.header('Content-Type'))) {
    throw new HttpProblem(415, 'unsupported_media_type');
  }
  const idempotencyKey = parseIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!idempotencyKey.ok) {
    throw new HttpProblem(400, idempotencyKey.error);
  }
  const body = await readJsonBody(c);
  return {
    body,
    origin: c.req.header('Origin') ?? null,
    idempotencyKey: idempotencyKey.value,
    clientIp: resolveClientIp(c.req.raw, clientIpOptions),
    userAgent: c.req.header('User-Agent') ?? null,
    correlationId: c.get('correlationId'),
  };
}

async function execute(c: Context<AppEnv>, deps: LeadCaptureRoutesDependencies): Promise<Handled> {
  try {
    const command = await readCommand(c, deps.clientIp);
    const result = await deps.submitLead(command);
    if (result.ok) {
      return { kind: 'accepted', result: result.value };
    }
    return { kind: 'rejected', problem: failureToProblem(result.error), failure: result.error };
  } catch (error) {
    if (error instanceof HttpProblem) {
      return { kind: 'rejected', problem: error, failure: undefined };
    }
    throw error;
  }
}

/** Unexpected rejections are rendered by the global error handler; here they are only counted. */
function codeOfUnexpectedError(error: unknown): ProblemCode {
  return error instanceof DependencyUnavailableError ? 'service_unavailable' : 'internal_error';
}

function recordMetrics(
  deps: LeadCaptureRoutesDependencies,
  attributes: Readonly<Record<string, string>>,
  durationMs: number,
  failure: SubmitLeadFailure | undefined,
): void {
  deps.metrics.record('lead_capture.requests', 1, attributes);
  deps.metrics.record('lead_capture.latency_ms', durationMs, {
    outcome: attributes.outcome ?? 'unknown',
  });
  if (failure?.code === 'rate_limited') {
    deps.metrics.record('ratelimit.blocked', 1, { scope: failure.scope });
  }
  if (failure?.code === 'bot_verification_failed') {
    deps.metrics.record('antibot.failures', 1, { reason: failure.reason });
  }
}

/** One structured line with codes and internal IDs only: no body, e-mail, phone, IP or token. */
function logHandled(c: Context<AppEnv>, handled: Handled): void {
  const logger = c.get('logger');
  if (handled.kind === 'accepted') {
    logger.info(
      {
        module: 'lead-capture',
        outcome: handled.result.outcome,
        submission_id: handled.result.accepted.submissionId,
        event_id: handled.result.accepted.eventId,
      },
      'lead capture handled',
    );
    return;
  }
  logger.info(
    {
      module: 'lead-capture',
      outcome: 'rejected',
      code: handled.problem.code,
      status: handled.problem.status,
      // Operators need the Turnstile reason and the limiter scope; clients never see them.
      ...(handled.failure?.code === 'bot_verification_failed' && {
        reason: handled.failure.reason,
      }),
      ...(handled.failure?.code === 'rate_limited' && { scope: handled.failure.scope }),
    },
    'lead capture handled',
  );
}

function observe(
  c: Context<AppEnv>,
  deps: LeadCaptureRoutesDependencies,
  handled: Handled,
  startedAt: number,
): void {
  const durationMs = Math.round(performance.now() - startedAt);
  if (handled.kind === 'accepted') {
    recordMetrics(deps, { outcome: handled.result.outcome }, durationMs, undefined);
  } else {
    recordMetrics(
      deps,
      { outcome: 'rejected', code: handled.problem.code },
      durationMs,
      handled.failure,
    );
  }
  logHandled(c, handled);
}

/**
 * Presentation of the `lead-capture` slice: `POST /v1/leads`. Thin by design — transport guards →
 * `SubmitLead` → response. The 202 body is identical in shape for a new lead, an existing lead, a
 * replay and a honeypot hit (R2); problems carry only the contract's stable `code`.
 */
export function createLeadCaptureRoutes(deps: LeadCaptureRoutesDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/v1/leads', async (c) => {
    const startedAt = performance.now();
    let handled: Handled;
    try {
      handled = await execute(c, deps);
    } catch (error) {
      const code = codeOfUnexpectedError(error);
      const durationMs = Math.round(performance.now() - startedAt);
      recordMetrics(deps, { outcome: 'error', code }, durationMs, undefined);
      throw error;
    }
    observe(c, deps, handled, startedAt);

    if (handled.kind === 'rejected') {
      return problemResponse(c, handled.problem);
    }
    const { submissionId, eventId } = handled.result.accepted;
    return c.json({ status: 'received', submission_id: submissionId, event_id: eventId }, 202);
  });

  return routes;
}
