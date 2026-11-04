/**
 * Single source of truth for the field rules of lead-capture §4 (limits, whitelists, formats).
 *
 * The domain validators consume these constants, the edge (Zod, Wave 4) derives its schemas from
 * them, and the property tests of AC-LC-13 assert that every accepted value satisfies them. The
 * database CHECK constraints (database §3.3–3.4) mirror them; the DB half of AC-LC-13 is Wave 4.
 */
import { FORBIDDEN_CHARACTERS, MAX_CONSECUTIVE_LINE_BREAKS } from '#/shared/text.ts';

/** A whitelist rule for one text field. Lengths are in Unicode code points, after normalization. */
export interface TextRule {
  readonly min: number;
  readonly max: number;
  /** Tests ONE code point; a code point outside the set yields `not_allowed_characters`. */
  readonly allowedChar?: RegExp;
  /** Structural whitelist for the whole normalized value; a mismatch yields `invalid_format`. */
  readonly pattern?: RegExp;
}

// ---------------------------------------------------------------------------
// Unicode pipeline (lead-capture §4, step 3): the forbidden characters and the line-break cap live
// in the shared kernel (the crm uses the same pipeline for staff notes) and are re-exported here.
export { FORBIDDEN_CHARACTERS, MAX_CONSECUTIVE_LINE_BREAKS } from '#/shared/text.ts';

// ---------------------------------------------------------------------------
// Names and free text

const NAME_PATTERN = /^[\p{L}\p{M}](?:[\p{L}\p{M}' .-]*[\p{L}\p{M}.])?$/u;
const NAME_CHAR = /^[\p{L}\p{M}' .-]$/u;

const COMPANY_PATTERN = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N} .,&'()/+-]*[\p{L}\p{M}\p{N}.)])?$/u;
const COMPANY_CHAR = /^[\p{L}\p{M}\p{N} .,&'()/+-]$/u;

export const TEXT_RULES = {
  firstName: { min: 1, max: 60, allowedChar: NAME_CHAR, pattern: NAME_PATTERN },
  lastName: { min: 1, max: 80, allowedChar: NAME_CHAR, pattern: NAME_PATTERN },
  company: { min: 2, max: 120, allowedChar: COMPANY_CHAR, pattern: COMPANY_PATTERN },
  areaOfExpertiseOther: { min: 2, max: 80, allowedChar: COMPANY_CHAR, pattern: COMPANY_PATTERN },
  jobTitle: { min: 2, max: 100, allowedChar: COMPANY_CHAR, pattern: COMPANY_PATTERN },
  message: { min: 1, max: 1000 },
} as const satisfies Record<string, TextRule>;

// ---------------------------------------------------------------------------
// E-mail
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_LOCAL_MAX_LENGTH = 64;
/** ASCII only, no quoted local part, no IP literal, TLD of at least 2 letters. Applied to the lowercased value. */
export const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)[a-z0-9_'+.-]*[a-z0-9_+-]@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** `crm.leads.email` CHECK (database §3.3). */
export const DB_EMAIL_CHECK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------------------
// WhatsApp
export const WHATSAPP_INPUT_MAX_LENGTH = 32;
/** Characters a user may type; everything else (letters, symbols) is `invalid_format`. */
export const WHATSAPP_INPUT_CHAR = /^[0-9 ()+.-]$/;
/** `crm.leads.whatsapp_e164` CHECK (database §3.3). */
export const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
export const WHATSAPP_DEFAULT_COUNTRY = 'BR';

// ---------------------------------------------------------------------------
// Enumerations live in `#/shared/lead-profile.ts` (AREAS_OF_EXPERTISE, COMPANY_SIZES).

// ---------------------------------------------------------------------------
// URLs
export const WEBSITE_MAX_LENGTH = 200;
export const TRACKING_URL_MAX_LENGTH = 2000;
/** Host names that are never a company website (never fetched in v1, but kept out of the CRM). */
export const RESERVED_HOST_SUFFIXES = [
  '.local',
  '.internal',
  '.localhost',
  '.localdomain',
] as const;
export const RESERVED_HOSTS = ['localhost'] as const;

// ---------------------------------------------------------------------------
// Technical envelope
export const FORM_KEY_PATTERN = /^frm_[a-z0-9_]{3,40}$/;
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
export const HONEYPOT_MAX_LENGTH = 200;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `Idempotency-Key`: UUID v4 or v7. */
export const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Tracking
export const TRACKING_RULES = {
  utm: { min: 1, max: 150, allowedChar: /^[\p{L}\p{N} ._+:/|-]$/u },
  clickId: { min: 1, max: 500, allowedChar: /^[A-Za-z0-9._~-]$/, pattern: /^[A-Za-z0-9._~-]+$/ },
  metaBrowserId: { min: 1, max: 500, pattern: /^fb\.[0-9]\.[0-9]{10,13}\.[A-Za-z0-9._-]+$/ },
  gaClientId: { min: 1, max: 100, pattern: /^[0-9]+\.[0-9]+$/ },
} as const satisfies Record<string, TextRule>;

/** Maximum code points a user-agent is stored with (`capture.submissions.user_agent` ≤ 512). */
export const USER_AGENT_MAX_LENGTH = 512;

// ---------------------------------------------------------------------------
// Acceptance predicates (used by AC-LC-13: every accepted value must satisfy them).
// They deliberately re-derive the invariants from the constants instead of calling the validators.

const SPACE_SEPARATORS = /\p{Zs}/u;

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/**
 * True when `value` is a fully normalized text satisfying `rule`: well-formed, NFC, no forbidden
 * characters (`\n` allowed when `multiline`), no edge whitespace, and — for single-line values —
 * no run of separators, length within limits, allowed characters and structure.
 */
export function satisfiesTextRule(value: string, rule: TextRule, multiline = false): boolean {
  if (!value.isWellFormed() || value.normalize('NFC') !== value || value !== value.trim()) {
    return false;
  }
  const withoutAllowedBreaks = multiline ? value.replaceAll('\n', '') : value;
  if (FORBIDDEN_CHARACTERS.test(withoutAllowedBreaks)) {
    return false;
  }
  if (!multiline && (value.includes('  ') || SPACE_SEPARATORS.test(value.replaceAll(' ', '')))) {
    return false;
  }
  if (multiline && value.includes('\n'.repeat(MAX_CONSECUTIVE_LINE_BREAKS + 1))) {
    return false;
  }
  const length = countCodePoints(value);
  if (length < rule.min || length > rule.max) {
    return false;
  }
  if (rule.allowedChar && !Array.from(value).every((char) => rule.allowedChar?.test(char))) {
    return false;
  }
  return rule.pattern ? rule.pattern.test(value) : true;
}

/** True when `value` is an accepted normalized e-mail (lowercase, format, limits). */
export function satisfiesEmailRule(value: string): boolean {
  const at = value.lastIndexOf('@');
  return (
    value === value.toLowerCase() &&
    countCodePoints(value) <= EMAIL_MAX_LENGTH &&
    at > 0 &&
    at <= EMAIL_LOCAL_MAX_LENGTH &&
    EMAIL_PATTERN.test(value) &&
    DB_EMAIL_CHECK.test(value)
  );
}

export function satisfiesE164Rule(value: string): boolean {
  return E164_PATTERN.test(value);
}
