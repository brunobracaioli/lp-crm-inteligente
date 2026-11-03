import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '#/platform/http/app-env.ts';

/** Stable machine codes (contracts/openapi.v1.yaml → components.schemas.Problem.code). */
export type ProblemCode =
  | 'invalid_json'
  | 'validation_failed'
  | 'idempotency_key_missing'
  | 'origin_not_allowed'
  | 'bot_verification_failed'
  | 'form_not_found'
  | 'not_found'
  | 'idempotency_in_progress'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'idempotency_key_reused'
  | 'rate_limited'
  | 'unauthorized'
  | 'internal_error'
  | 'bot_verification_unavailable'
  | 'service_unavailable';

export type FieldErrorCode =
  | 'required'
  | 'too_short'
  | 'too_long'
  | 'invalid_format'
  | 'invalid_choice'
  | 'not_allowed_characters'
  | 'must_be_true'
  | 'not_allowed';

export interface FieldError {
  readonly field: string;
  readonly code: FieldErrorCode;
}

const TITLES: Readonly<Record<ProblemCode, string>> = {
  invalid_json: 'Invalid JSON',
  validation_failed: 'Validation failed',
  idempotency_key_missing: 'Idempotency key missing',
  origin_not_allowed: 'Origin not allowed',
  bot_verification_failed: 'Bot verification failed',
  form_not_found: 'Form not found',
  not_found: 'Not found',
  idempotency_in_progress: 'Request in progress',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  idempotency_key_reused: 'Idempotency key reused',
  rate_limited: 'Too many requests',
  unauthorized: 'Unauthorized',
  internal_error: 'Internal error',
  bot_verification_unavailable: 'Bot verification unavailable',
  service_unavailable: 'Service unavailable',
};

/** Max field errors returned (contract: Problem.errors maxItems). */
const MAX_FIELD_ERRORS = 50;

export interface HttpProblemOptions {
  readonly errors?: readonly FieldError[];
  readonly retryAfterSeconds?: number;
}

/**
 * An expected, client-facing failure. Throw it from guards or map use case errors to it; the
 * global error handler renders it as application/problem+json. Carries no internal detail.
 */
export class HttpProblem extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ProblemCode;
  readonly errors: readonly FieldError[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: ContentfulStatusCode, code: ProblemCode, options: HttpProblemOptions = {}) {
    super(code);
    this.name = 'HttpProblem';
    this.status = status;
    this.code = code;
    this.errors = options.errors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function problemResponse(c: Context<AppEnv>, problem: HttpProblem): Response {
  const body = {
    type: `${new URL(c.req.url).origin}/problems/${problem.code}`,
    title: TITLES[problem.code],
    status: problem.status,
    code: problem.code,
    correlation_id: c.get('correlationId'),
    ...(problem.errors === undefined ? {} : { errors: problem.errors.slice(0, MAX_FIELD_ERRORS) }),
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/problem+json' };
  if (problem.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(problem.retryAfterSeconds)));
  }
  return c.body(JSON.stringify(body), problem.status, headers);
}
