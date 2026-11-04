import { err, ok, type Result } from '#/shared/result.ts';
import { isDisposableEmailDomain } from '#/modules/lead-capture/domain/disposable-domains.ts';
import type { FieldErrorCode } from '#/modules/lead-capture/domain/field-error.ts';
import {
  EMAIL_LOCAL_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  EMAIL_PATTERN,
} from '#/modules/lead-capture/domain/rules.ts';
import { codePointLength, normalizeText } from '#/modules/lead-capture/domain/text.ts';

/**
 * E-mail field (lead-capture §4.1): pipeline + lowercase, ≤ 254 (local part ≤ 64), strict ASCII
 * format, disposable domains rejected as `invalid_choice` (Q3). Returns the lowercase address.
 */
export function parseEmail(raw: unknown): Result<string, FieldErrorCode> {
  if (typeof raw !== 'string') {
    return err('invalid_format');
  }
  const normalized = normalizeText(raw);
  if (!normalized.ok) {
    return normalized;
  }
  const value = normalized.value.toLowerCase();
  if (value === '') {
    return err('required');
  }
  if (codePointLength(value) > EMAIL_MAX_LENGTH) {
    return err('too_long');
  }
  if (!EMAIL_PATTERN.test(value)) {
    return err('invalid_format');
  }
  const at = value.lastIndexOf('@');
  if (at > EMAIL_LOCAL_MAX_LENGTH) {
    return err('too_long');
  }
  if (isDisposableEmailDomain(value.slice(at + 1))) {
    return err('invalid_choice');
  }
  return ok(value);
}
