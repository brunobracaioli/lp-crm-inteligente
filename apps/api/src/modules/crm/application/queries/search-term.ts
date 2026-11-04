import { err, ok, type Result } from '#/shared/result.ts';

export const SEARCH_TERM_MIN_LENGTH = 2;
export const SEARCH_TERM_MAX_LENGTH = 80;

export type SearchTermError = 'too_short' | 'too_long' | 'not_allowed_characters';

/** Control, format (zero-width, bidi), lone-surrogate, line/paragraph separator and U+FFFD. */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}�]/u;
const SPACE_SEPARATOR_RUN = /\p{Zs}+/gu;

/** A search term after the Unicode pipeline; only `parseSearchTerm` creates one. */
export type SearchTerm = string & { readonly __searchTerm: true };

/**
 * Unicode pipeline of the search body (contract `searchLeads`): NFC, trim, collapse of inner space
 * separators, rejection of control/format characters, then 2–80 code points. Wildcards (`%`, `_`,
 * `\`) are ordinary characters here; the SQL adapter treats them as literals. Never throws.
 */
export function parseSearchTerm(raw: string): Result<SearchTerm, SearchTermError> {
  if (!raw.isWellFormed()) {
    return err('not_allowed_characters');
  }
  const value = raw.normalize('NFC').trim().replace(SPACE_SEPARATOR_RUN, ' ');
  if (FORBIDDEN_CHARACTERS.test(value)) {
    return err('not_allowed_characters');
  }
  const length = Array.from(value).length;
  if (length < SEARCH_TERM_MIN_LENGTH) {
    return err('too_short');
  }
  if (length > SEARCH_TERM_MAX_LENGTH) {
    return err('too_long');
  }
  return ok(value as SearchTerm);
}
