import { err, ok, type Result } from '#/shared/result.ts';

/**
 * Normalization of customer identifiers before SHA-256 (Meta "Customer Information Parameters").
 * The domain only produces normalized plain strings; hashing happens in `application/` because
 * `domain/` may not import `#/platform/crypto`.
 *
 * Meta rules applied (see normalization.test.ts for the documented hash vectors):
 * - em: trim, lowercase.
 * - ph: digits only, no leading zeros, country code included (input is already E.164).
 * - fn/ln: lowercase, no punctuation, special characters kept as UTF-8 (NFC).
 * - external_id: no normalization beyond trimming (Meta defines no rule).
 */
export type NormalizationError =
  'invalid_email' | 'invalid_phone' | 'empty_first_name' | 'empty_last_name' | 'empty_external_id';

/** Normalized (not yet hashed) identifiers. Plain PII: lives in memory only, never logged. */
export interface NormalizedIdentity {
  readonly email: string;
  readonly phone: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly externalId: string;
}

export interface RawIdentity {
  readonly email: string;
  /** E.164 as stored by lead-capture (`+5511999998888`). */
  readonly whatsappE164: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Internal lead id: sent as `external_id` (tracking §5.2). */
  readonly externalId: string;
}

const MAX_EMAIL_LENGTH = 254;
/** E.164 allows at most 15 digits; below 7 cannot be a dialable number with country code. */
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/u;
const NON_DIGITS = /\D/gu;
const LEADING_ZEROS = /^0+/u;
const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]/gu;
const WHITESPACE_RUN = /\s+/gu;

export function normalizeEmail(raw: string): Result<string, 'invalid_email'> {
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
    return err('invalid_email');
  }
  return ok(email);
}

export function normalizePhone(raw: string): Result<string, 'invalid_phone'> {
  const digits = raw.replace(NON_DIGITS, '').replace(LEADING_ZEROS, '');
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return err('invalid_phone');
  }
  return ok(digits);
}

/** Shared by `fn` and `ln`. Returns an empty string when nothing but punctuation was given. */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(PUNCTUATION_AND_SYMBOLS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .normalize('NFC');
}

export function normalizeIdentity(
  raw: RawIdentity,
): Result<NormalizedIdentity, NormalizationError> {
  const email = normalizeEmail(raw.email);
  if (!email.ok) return email;
  const phone = normalizePhone(raw.whatsappE164);
  if (!phone.ok) return phone;
  const firstName = normalizeName(raw.firstName);
  if (firstName === '') return err('empty_first_name');
  const lastName = normalizeName(raw.lastName);
  if (lastName === '') return err('empty_last_name');
  const externalId = raw.externalId.trim();
  if (externalId === '') return err('empty_external_id');
  return ok({
    email: email.value,
    phone: phone.value,
    firstName,
    lastName,
    externalId,
  });
}
