import { z } from 'zod';
import { HttpProblem, type FieldError, type FieldErrorCode } from '#/platform/errors/problem.ts';
import { MAX_PAGE_SIZE } from '#/modules/crm/application/queries/pagination.ts';
import { LEAD_STAGES } from '#/modules/crm/domain/lead-types.ts';

/**
 * Strict request schemas of the read routes (contract: unknown query parameter or body field → 400,
 * limits per `components.parameters`). Problems carry field paths and stable codes only — never the
 * rejected value (it may be PII).
 */

const UUID_LOWERCASE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OWNER_PATTERN = new RegExp(`^(me|unassigned|${UUID_LOWERCASE})$`);
const CURSOR_PATTERN = /^[A-Za-z0-9_.~-]+$/;
const MAX_CURSOR_LENGTH = 512;
const MAX_OWNER_LENGTH = 36;
const MAX_FIELD_PATH_LENGTH = 64;
const LIMIT_DIGITS = /^[0-9]{1,3}$/;

const stage = z.enum(LEAD_STAGES);
const scoreBand = z.enum(['A', 'B', 'C']);
const owner = z.string().max(MAX_OWNER_LENGTH).regex(OWNER_PATTERN);
const cursor = z.string().min(1).max(MAX_CURSOR_LENGTH).regex(CURSOR_PATTERN);
const pageLimit = z.number().int().min(1).max(MAX_PAGE_SIZE);
/** Query strings carry the limit as text: digits only, then the same range as the JSON number. */
const pageLimitFromQuery = z.string().regex(LIMIT_DIGITS).transform(Number).pipe(pageLimit);

export const leadListQuerySchema = z.strictObject({
  stage: stage.optional(),
  owner: owner.optional(),
  score_band: scoreBand.optional(),
  limit: pageLimitFromQuery.optional(),
  cursor: cursor.optional(),
});

export const leadSearchBodySchema = z.strictObject({
  q: z.string().optional(),
  stage: stage.optional(),
  owner: owner.optional(),
  score_band: scoreBand.optional(),
  limit: pageLimit.optional(),
  cursor: cursor.optional(),
});

export const leadDetailQuerySchema = z.strictObject({
  activities_limit: pageLimitFromQuery.optional(),
  activities_cursor: cursor.optional(),
});

export const leadIdSchema = z.guid();

function sanitizeFieldPath(path: string): string {
  const safe = path.replace(/[^A-Za-z0-9_.-]/g, '_');
  return safe.slice(0, MAX_FIELD_PATH_LENGTH) || 'request';
}

function codeOf(issue: z.core.$ZodIssue): FieldErrorCode {
  switch (issue.code) {
    case 'invalid_value':
      return 'invalid_choice';
    case 'too_small':
      return issue.origin === 'string' ? 'too_short' : 'invalid_format';
    case 'too_big':
      return issue.origin === 'string' ? 'too_long' : 'invalid_format';
    default:
      return 'invalid_format';
  }
}

/** Zod issues → contract `FieldError[]` (deduplicated; extra keys are `not_allowed`). */
export function fieldErrorsOf(error: z.ZodError): readonly FieldError[] {
  const errors = new Map<string, FieldError>();
  const add = (path: string, code: FieldErrorCode): void => {
    const field = sanitizeFieldPath(path);
    errors.set(`${field}:${code}`, { field, code });
  };
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const base = issue.path.map(String).join('.');
      for (const key of issue.keys) {
        add(base === '' ? key : `${base}.${key}`, 'not_allowed');
      }
    } else {
      add(issue.path.map(String).join('.'), codeOf(issue));
    }
  }
  return [...errors.values()];
}

export function validationProblem(errors: readonly FieldError[]): HttpProblem {
  return new HttpProblem(400, 'validation_failed', { errors });
}

/**
 * Query string → plain object. A repeated parameter is rejected (it would otherwise be silently
 * resolved to one of the values), reported by name only.
 */
export function readQueryParameters(url: string): Record<string, string> {
  // A Map keeps `__proto__` and friends as ordinary keys; `Object.fromEntries` then defines them as
  // own properties, which the strict schemas reject as unknown parameters.
  const parameters = new Map<string, string>();
  const repeated = new Set<string>();
  for (const [name, value] of new URL(url).searchParams) {
    if (parameters.has(name)) repeated.add(name);
    parameters.set(name, value);
  }
  if (repeated.size > 0) {
    throw validationProblem(
      [...repeated].map((name) => ({ field: sanitizeFieldPath(name), code: 'not_allowed' })),
    );
  }
  return Object.fromEntries(parameters);
}

export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw validationProblem(fieldErrorsOf(parsed.error));
  }
  return parsed.data;
}
