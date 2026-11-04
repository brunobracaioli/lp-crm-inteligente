import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '#/platform/http/app-env.ts';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { HttpProblem, problemResponse } from '#/platform/errors/problem.ts';

const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNAUTHORIZED = 401;
/** `Retry-After` for a dependency outage (lead-capture §7: Postgres down → 5 s). */
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

/** Maps framework exceptions to stable problem codes; everything else becomes a generic 500. */
function toProblem(error: unknown): HttpProblem | undefined {
  if (error instanceof HttpProblem) return error;
  if (error instanceof HTTPException) {
    if (error.status === HTTP_PAYLOAD_TOO_LARGE) return new HttpProblem(413, 'payload_too_large');
    if (error.status === HTTP_UNAUTHORIZED) return new HttpProblem(401, 'unauthorized');
  }
  return undefined;
}

/** Global handler: never leaks stack traces, driver messages or which barrier failed. */
export const errorHandler: ErrorHandler<AppEnv> = (error, c) => {
  const problem = toProblem(error);
  if (problem !== undefined) {
    return problemResponse(c, problem);
  }
  if (error instanceof DependencyUnavailableError) {
    c.get('logger').warn({ dependency: error.dependency }, 'dependency unavailable');
    return problemResponse(
      c,
      new HttpProblem(503, 'service_unavailable', {
        retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS,
      }),
    );
  }
  c.get('logger').error({ err: error }, 'unhandled error');
  return problemResponse(c, new HttpProblem(500, 'internal_error'));
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c: Context<AppEnv>) =>
  problemResponse(c, new HttpProblem(404, 'not_found'));
