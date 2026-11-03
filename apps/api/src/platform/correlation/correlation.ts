import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import type { AppEnv } from '#/platform/http/app-env.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { CorrelationId } from '#/shared/ids.ts';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accepts the client's X-Request-Id only when it is a UUID; otherwise generates one. */
export function resolveCorrelationId(incoming: string | undefined): CorrelationId {
  const candidate = incoming?.trim();
  return (
    candidate !== undefined && UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : randomUUID()
  ) as CorrelationId;
}

/**
 * Sets `correlationId` and a child `logger` on the context, echoes X-Request-Id on every response
 * and logs one structured line per request (no PII: method, route, status, duration only).
 */
export function correlation(rootLogger: Logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const startedAt = performance.now();
    const correlationId = resolveCorrelationId(c.req.header(REQUEST_ID_HEADER));
    const logger = rootLogger.child({ correlation_id: correlationId });
    c.set('correlationId', correlationId);
    c.set('logger', logger);

    await next();

    c.res.headers.set(REQUEST_ID_HEADER, correlationId);
    logger.info(
      {
        method: c.req.method,
        route: routePath(c),
        status: c.res.status,
        duration_ms: Math.round(performance.now() - startedAt),
      },
      'request completed',
    );
  });
}
