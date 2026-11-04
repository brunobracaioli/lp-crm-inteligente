import { z } from 'zod';
import type {
  CommandFailure,
  FieldError,
  FieldErrorCode,
  RawBody,
} from '#/modules/crm/application/commands/failures.ts';
import { LEAD_STAGES, LOST_REASONS } from '#/modules/crm/domain/lead-types.ts';
import type { LeadStage, LostReason, ScoreBand } from '#/modules/crm/domain/lead-types.ts';
import type { UserId } from '#/shared/ids.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import { codePointLength, normalizeText } from '#/shared/text.ts';

/**
 * Edge validation of the crm write and privacy operations: every schema is `.strict()` (a key the
 * contract does not name is a `400`, never silently dropped — mass assignment, C17) and errors
 * carry only the field path and a stable code.
 */

export const MAX_VERSION = 2_147_483_647;
export const NOTE_MAX_CODE_POINTS = 5_000;
/**
 * `crm.lead_activities.data` is capped at 8192 bytes by a CHECK. A note of 5 000 code points can
 * need 20 KB in UTF-8, so the byte size is bounded too, leaving room for the jsonb overhead.
 */
export const NOTE_MAX_UTF8_BYTES = 8_000;
const MAX_FIELD_PATH_LENGTH = 64;
const PLAN_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TARGET_STAGES = LEAD_STAGES.filter((stage) => stage !== 'new');
const SCORE_BANDS = ['A', 'B', 'C'] as const;

const versionSchema = z.number().int().min(1).max(MAX_VERSION);

// ---------------------------------------------------------------------------
// Zod → stable field errors

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function codeFor(issue: z.core.$ZodIssue, raw: unknown): FieldErrorCode {
  if (valueAt(raw, issue.path) === undefined) {
    return 'required';
  }
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

function fieldName(path: readonly PropertyKey[]): string {
  const joined = path.map(String).join('.');
  return (joined === '' ? 'body' : joined).slice(0, MAX_FIELD_PATH_LENGTH);
}

export function fieldErrorsFromZod(error: z.ZodError, raw: unknown): FieldError[] {
  return error.issues.flatMap((issue): FieldError[] => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: fieldName([...issue.path, key]),
        code: 'not_allowed',
      }));
    }
    return [{ field: fieldName(issue.path), code: codeFor(issue, raw) }];
  });
}

function parseWith<S extends z.ZodType>(
  schema: S,
  body: RawBody,
): Result<z.infer<S>, CommandFailure> {
  if (body.kind === 'invalid_json') {
    return err({ code: 'invalid_json' });
  }
  if (body.kind === 'unsupported_media_type') {
    return err({ code: 'unsupported_media_type' });
  }
  const parsed = schema.safeParse(body.value);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err({ code: 'validation_failed', errors: fieldErrorsFromZod(parsed.error, body.value) });
}

function validationFailure(errors: readonly FieldError[]): Result<never, CommandFailure> {
  return err({ code: 'validation_failed', errors });
}

// ---------------------------------------------------------------------------
// Bodies

export interface StageChangeInput {
  readonly toStage: LeadStage;
  readonly lostReason: LostReason | null;
  readonly expectedVersion: number;
}

const stageBodySchema = z.strictObject({
  to_stage: z.enum(TARGET_STAGES as [LeadStage, ...LeadStage[]]),
  lost_reason: z.enum(LOST_REASONS).optional(),
  expected_version: versionSchema,
});

export function parseStageChangeBody(body: RawBody): Result<StageChangeInput, CommandFailure> {
  const parsed = parseWith(stageBodySchema, body);
  if (!parsed.ok) {
    return parsed;
  }
  const {
    to_stage: toStage,
    lost_reason: lostReason,
    expected_version: expectedVersion,
  } = parsed.value;
  if (toStage === 'lost' && lostReason === undefined) {
    return validationFailure([{ field: 'lost_reason', code: 'required' }]);
  }
  if (toStage !== 'lost' && lostReason !== undefined) {
    return validationFailure([{ field: 'lost_reason', code: 'not_allowed' }]);
  }
  return ok({ toStage, lostReason: lostReason ?? null, expectedVersion });
}

export interface OwnerChangeInput {
  readonly ownerUserId: UserId | null;
  readonly expectedVersion: number;
}

const ownerBodySchema = z.strictObject({
  owner_user_id: z.string().regex(UUID_PATTERN).nullable(),
  expected_version: versionSchema,
});

export function parseOwnerChangeBody(body: RawBody): Result<OwnerChangeInput, CommandFailure> {
  const parsed = parseWith(ownerBodySchema, body);
  if (!parsed.ok) {
    return parsed;
  }
  const { owner_user_id: owner, expected_version: expectedVersion } = parsed.value;
  return ok({
    ownerUserId: owner === null ? null : (owner.toLowerCase() as UserId),
    expectedVersion,
  });
}

const noteBodySchema = z.strictObject({ body: z.string() });

/** Note text after the Unicode pipeline of lead-capture §4 (multiline), 1–5000 code points. */
export function parseNoteBody(body: RawBody): Result<string, CommandFailure> {
  const parsed = parseWith(noteBodySchema, body);
  if (!parsed.ok) {
    return parsed;
  }
  const normalized = normalizeText(parsed.value.body, true);
  if (!normalized.ok) {
    return validationFailure([{ field: 'body', code: 'not_allowed_characters' }]);
  }
  const text = normalized.value;
  if (text === '') {
    return validationFailure([{ field: 'body', code: 'required' }]);
  }
  if (
    codePointLength(text) > NOTE_MAX_CODE_POINTS ||
    new TextEncoder().encode(text).length > NOTE_MAX_UTF8_BYTES
  ) {
    return validationFailure([{ field: 'body', code: 'too_long' }]);
  }
  return ok(text);
}

export type AnonymizeInput =
  { readonly confirm: false } | { readonly confirm: true; readonly planHash: string };

const anonymizeBodySchema = z.strictObject({
  confirm: z.boolean().optional(),
  plan_hash: z.string().regex(PLAN_HASH_PATTERN).optional(),
});

export function parseAnonymizeBody(body: RawBody): Result<AnonymizeInput, CommandFailure> {
  const parsed = parseWith(anonymizeBodySchema, body);
  if (!parsed.ok) {
    return parsed;
  }
  const { confirm, plan_hash: planHash } = parsed.value;
  if (confirm === true) {
    return planHash === undefined
      ? validationFailure([{ field: 'plan_hash', code: 'required' }])
      : ok({ confirm: true, planHash });
  }
  return planHash === undefined
    ? ok({ confirm: false })
    : validationFailure([{ field: 'plan_hash', code: 'not_allowed' }]);
}

/** Whether the body asks for the destructive step; unparseable bodies count as a preview. */
export function bodyRequestsConfirmation(body: RawBody): boolean {
  if (body.kind !== 'json' || typeof body.value !== 'object' || body.value === null) {
    return false;
  }
  return (body.value as Record<string, unknown>).confirm === true;
}

// ---------------------------------------------------------------------------
// Export query

export type ExportOwnerQuery = 'me' | 'unassigned' | UserId;

export interface ExportQueryInput {
  readonly stage: LeadStage | undefined;
  readonly owner: ExportOwnerQuery | undefined;
  readonly scoreBand: ScoreBand | undefined;
}

const exportQuerySchema = z.strictObject({
  stage: z.enum(LEAD_STAGES).optional(),
  owner: z
    .string()
    .regex(/^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
    .optional(),
  score_band: z.enum(SCORE_BANDS).optional(),
});

/** Query parameters as the presentation layer collected them (name → every value received). */
export type RawQuery = ReadonlyMap<string, readonly string[]>;

export function parseExportQuery(query: RawQuery): Result<ExportQueryInput, CommandFailure> {
  const errors: FieldError[] = [];
  for (const [name, values] of query) {
    if (values.length > 1) {
      errors.push({ field: name.slice(0, MAX_FIELD_PATH_LENGTH), code: 'not_allowed' });
    }
  }
  if (errors.length > 0) {
    return validationFailure(errors);
  }
  // `fromEntries` defines own properties, so a hostile name such as `__proto__` stays plain data.
  const flat = Object.fromEntries([...query].map(([name, values]) => [name, values[0] ?? '']));
  const parsed = exportQuerySchema.safeParse(flat);
  if (!parsed.success) {
    return validationFailure(fieldErrorsFromZod(parsed.error, flat));
  }
  const owner = parsed.data.owner;
  return ok({
    stage: parsed.data.stage,
    owner:
      owner === undefined || owner === 'me' || owner === 'unassigned'
        ? owner
        : (owner.toLowerCase() as UserId),
    scoreBand: parsed.data.score_band,
  });
}
