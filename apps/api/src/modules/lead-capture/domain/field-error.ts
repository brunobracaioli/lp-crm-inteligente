/**
 * Stable per-field error codes (lead-capture §3). The edge translates them to RFC 9457 `errors[]`;
 * the front maps them to pt-BR messages. The server never echoes the received value or the regex.
 */
export const FIELD_ERROR_CODES = [
  'required',
  'too_short',
  'too_long',
  'invalid_format',
  'invalid_choice',
  'not_allowed_characters',
  'must_be_true',
  'not_allowed',
] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

export interface FieldError {
  /** Dotted path, at most 64 characters (e.g. `whatsapp`, `tracking.fbp`). */
  readonly field: string;
  readonly code: FieldErrorCode;
}

/** OpenAPI `Problem.errors` has `maxItems: 50`. */
export const MAX_FIELD_ERRORS = 50;
