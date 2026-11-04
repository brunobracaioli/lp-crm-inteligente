import { err, ok, type Result } from '#/shared/result.ts';

/**
 * Pure Unicode text pipeline shared by lead-capture (form fields, lead-capture §4) and the crm
 * (staff notes): the crm cannot import lead-capture internals, so the pipeline lives in the shared
 * kernel and `lead-capture/domain/text.ts` re-exports it unchanged.
 */

/**
 * Characters rejected in every text field: \p{Cc} control, \p{Cf} format (zero-width, bidi
 * overrides, BOM), \p{Cs} lone surrogates, \p{Zl}/\p{Zp} line and paragraph separators and the
 * U+FFFD replacement character.
 */
export const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}�]/u;

/** Multiline text keeps `\n` (after CRLF normalization) and caps consecutive line breaks. */
export const MAX_CONSECUTIVE_LINE_BREAKS = 10;

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
