import { err, ok, type Result } from '#/shared/result.ts';
import { codePointLength, normalizeText } from '#/shared/text.ts';
import type { FieldErrorCode } from '#/modules/lead-capture/domain/field-error.ts';
import type { TextRule } from '#/modules/lead-capture/domain/rules.ts';

// The pure half of the pipeline lives in the shared kernel (the crm reuses it for staff notes).
export { codePointLength, normalizeText, truncateCodePoints } from '#/shared/text.ts';

/**
 * Applies the whole text pipeline plus `rule` to an untrusted value.
 * Returns the normalized string (never empty: an empty result is `required`).
 */
export function readText(
  raw: unknown,
  rule: TextRule,
  multiline = false,
): Result<string, FieldErrorCode> {
  if (typeof raw !== 'string') {
    return err('invalid_format');
  }
  const normalized = normalizeText(raw, multiline);
  if (!normalized.ok) {
    return normalized;
  }
  return applyTextRule(normalized.value, rule);
}

/** Length, character whitelist and structure checks on an already normalized value. */
export function applyTextRule(value: string, rule: TextRule): Result<string, FieldErrorCode> {
  if (value === '') {
    return err('required');
  }
  const length = codePointLength(value);
  if (length < rule.min) {
    return err('too_short');
  }
  if (length > rule.max) {
    return err('too_long');
  }
  if (rule.allowedChar && !Array.from(value).every((char) => rule.allowedChar?.test(char))) {
    return err('not_allowed_characters');
  }
  if (rule.pattern && !rule.pattern.test(value)) {
    return err('invalid_format');
  }
  return ok(value);
}
