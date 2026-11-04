import { err, ok, type Result } from '#/shared/result.ts';
import type { FieldErrorCode } from '#/modules/lead-capture/domain/field-error.ts';
import {
  FORBIDDEN_CHARACTERS,
  MAX_CONSECUTIVE_LINE_BREAKS,
  type TextRule,
} from '#/modules/lead-capture/domain/rules.ts';

const CRLF_OR_CR = /\r\n?/g;
const LINE_BREAK_RUN = new RegExp(`\\n{${String(MAX_CONSECUTIVE_LINE_BREAKS + 1)},}`, 'g');
const SEPARATOR_RUN = /\p{Zs}+/gu;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Cuts `value` to at most `maxCodePoints` code points without splitting a surrogate pair. */
export function truncateCodePoints(value: string, maxCodePoints: number): string {
  return Array.from(value).slice(0, maxCodePoints).join('');
}

/**
 * Unicode pipeline of lead-capture §4 (steps 2–3): NFC, trim, collapse of inner space separators
 * (single-line) or CRLF normalization and line-break cap (multiline), then rejection of control,
 * format (zero-width, bidi), lone-surrogate and replacement characters. Never throws.
 */
export function normalizeText(
  raw: string,
  multiline = false,
): Result<string, 'not_allowed_characters'> {
  if (!raw.isWellFormed()) {
    return err('not_allowed_characters');
  }
  const trimmed = raw.normalize('NFC').trim();
  const value = multiline
    ? trimmed
        .replace(CRLF_OR_CR, '\n')
        .replace(LINE_BREAK_RUN, '\n'.repeat(MAX_CONSECUTIVE_LINE_BREAKS))
    : trimmed.replace(SEPARATOR_RUN, ' ');
  const inspected = multiline ? value.replaceAll('\n', '') : value;
  return FORBIDDEN_CHARACTERS.test(inspected) ? err('not_allowed_characters') : ok(value);
}

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
