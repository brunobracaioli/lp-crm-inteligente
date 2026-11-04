import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { DispatchOutboxEvent } from '#/modules/tracking/application/dispatch-outbox-event.ts';
import type { SignatureVerifier } from '#/modules/tracking/application/ports.ts';
import type { SweepOutbox } from '#/modules/tracking/application/sweep-outbox.ts';
import { OUTBOX_DISPATCH_PATH } from '#/modules/tracking/infrastructure/qstash-publisher.ts';
import { HttpProblem, problemResponse } from '#/platform/errors/problem.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import type { OutboxEventId, WorkspaceId } from '#/shared/ids.ts';

/** Path QStash calls on the sweeper schedule (contracts/openapi.v1.yaml `sweepOutbox`). */
export const OUTBOX_SWEEP_PATH = '/internal/v1/outbox/sweep';

const SIGNATURE_HEADER = 'Upstash-Signature';
/** Tracking §6: these bodies are tiny; anything bigger is not QStash talking. */
const MAX_INTERNAL_BODY_BYTES = 1024;
const TRAILING_SLASHES = /\/+$/u;

const dispatchBodySchema = z.object({ outbox_event_id: z.uuid() }).strict();
const sweepBodySchema = z.object({}).strict();

export interface OutboxRoutesDependencies {
  /** QStash `Upstash-Signature` verifier (current + next signing key). */
  readonly verifier: SignatureVerifier;
  readonly dispatchOutboxEvent: DispatchOutboxEvent;
  readonly sweepOutbox: SweepOutbox;
  /**
   * Tenant these internal calls act on. v1 runs one workspace (ADR-0006) and the QStash bodies
   * carry no workspace, so it comes from server config (`DEFAULT_WORKSPACE_ID`), never from the
   * request: a caller cannot choose a tenant.
   */
  readonly workspaceId: WorkspaceId;
  /**
   * `PUBLIC_API_BASE_URL`. The signature's `sub` claim is the exact URL QStash called, so the
   * expected URL is built from config instead of trusting the Host/proto the proxy forwarded.
   */
  readonly publicApiBaseUrl: string;
}

function internalUrl(publicApiBaseUrl: string, path: string): string {
  const base = new URL(publicApiBaseUrl);
  return `${base.origin}${base.pathname.replace(TRAILING_SLASHES, '')}${path}`;
}

/**
 * Authenticates the call BEFORE anything else (deny by default, tracking §6): a valid QStash
 * signature over this URL and the raw body. Returns the raw body for validation. Nothing about the
 * source IP or any shared header is trusted. The verifier already logs the rejection reason and
 * increments `auth.qstash_signature_invalid`; the client only ever sees a generic 401.
 */
async function authenticate(
  c: Context<AppEnv>,
  verifier: SignatureVerifier,
  url: string,
): Promise<string> {
  const rawBody = await c.req.text();
  const verified = await verifier.verify({
    signature: c.req.header(SIGNATURE_HEADER) ?? null,
    rawBody,
    url,
  });
  if (!verified) {
    throw new HttpProblem(401, 'unauthorized');
  }
  return rawBody;
}

/** Size, JSON syntax and `.strict()` schema, in that order; failures are 413/400 problems. */
function parseBody<T>(rawBody: string, schema: z.ZodType<T>): T {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_INTERNAL_BODY_BYTES) {
    throw new HttpProblem(413, 'payload_too_large');
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new HttpProblem(400, 'invalid_json');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpProblem(400, 'validation_failed');
  }
  return parsed.data;
}

/**
 * `POST /internal/v1/outbox/dispatch` and `POST /internal/v1/outbox/sweep` (tracking §6, ADR-0004).
 * Thin by design: signature → strict body → use case → status. QStash retries any non-2xx, so:
 * `200` means "nothing left to do" (done, already processed, dead-lettered, unknown event) and `500`
 * means "try again" (a delivery failed retryably, or another worker holds the event).
 */
export function createOutboxRoutes(deps: OutboxRoutesDependencies): Hono<AppEnv> {
  const dispatchUrl = internalUrl(deps.publicApiBaseUrl, OUTBOX_DISPATCH_PATH);
  const sweepUrl = internalUrl(deps.publicApiBaseUrl, OUTBOX_SWEEP_PATH);
  const routes = new Hono<AppEnv>();

  routes.post(OUTBOX_DISPATCH_PATH, async (c) => {
    const rawBody = await authenticate(c, deps.verifier, dispatchUrl);
    const body = parseBody(rawBody, dispatchBodySchema);

    const outcome = await deps.dispatchOutboxEvent({
      workspaceId: deps.workspaceId,
      outboxEventId: body.outbox_event_id as OutboxEventId,
      correlationId: c.get('correlationId'),
    });

    if (outcome.kind === 'retry_later') {
      return problemResponse(c, new HttpProblem(500, 'internal_error'));
    }
    return c.body(null, 200);
  });

  routes.post(OUTBOX_SWEEP_PATH, async (c) => {
    const rawBody = await authenticate(c, deps.verifier, sweepUrl);
    parseBody(rawBody, sweepBodySchema);

    const result = await deps.sweepOutbox({
      workspaceId: deps.workspaceId,
      correlationId: c.get('correlationId'),
    });

    return c.json({ republished: result.republished });
  });

  return routes;
}
