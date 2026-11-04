import { err, type Result } from '#/shared/result.ts';

/** Per-field validation codes (subset of the contract's `FieldError.code`). */
export type FieldErrorCode =
  | 'required'
  | 'too_short'
  | 'too_long'
  | 'invalid_format'
  | 'invalid_choice'
  | 'not_allowed_characters'
  | 'not_allowed';

export interface FieldError {
  readonly field: string;
  readonly code: FieldErrorCode;
}

/**
 * Why a command was refused. The presentation layer maps each code to its HTTP problem; nothing
 * here carries a received value (no PII, no echo).
 */
export type CommandFailure =
  | { readonly code: 'not_found' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'validation_failed'; readonly errors: readonly FieldError[] }
  | { readonly code: 'invalid_json' }
  | { readonly code: 'unsupported_media_type' }
  | { readonly code: 'idempotency_key_missing' }
  | { readonly code: 'idempotency_key_reused' }
  | { readonly code: 'idempotency_in_progress'; readonly retryAfterSeconds: number }
  /** Replay protection is mandatory for this operation and its store is unavailable (→ 503). */
  | { readonly code: 'idempotency_unavailable' }
  /** The user already has an export running (→ 429 `rate_limited`). */
  | { readonly code: 'export_in_progress'; readonly retryAfterSeconds: number }
  | { readonly code: 'version_conflict' }
  | { readonly code: 'lead_anonymized' }
  | { readonly code: 'invalid_stage_transition' }
  | { readonly code: 'plan_stale' };

export type CommandResult<T> = Result<T, CommandFailure>;

export function fail(failure: CommandFailure): Result<never, CommandFailure> {
  return err(failure);
}

export function invalidField(field: string, code: FieldErrorCode): Result<never, CommandFailure> {
  return err({ code: 'validation_failed', errors: [{ field, code }] });
}

/**
 * A request body as the presentation layer read it. Reading problems are values, not exceptions,
 * because the contract orders them after the resource checks (an unreadable body on a lead of
 * another workspace is still `404`).
 */
export type RawBody =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'invalid_json' }
  | { readonly kind: 'unsupported_media_type' };
