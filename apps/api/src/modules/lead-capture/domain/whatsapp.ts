import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { err, ok, type Result } from '#/shared/result.ts';
import type { FieldErrorCode } from '#/modules/lead-capture/domain/field-error.ts';
import {
  E164_PATTERN,
  WHATSAPP_DEFAULT_COUNTRY,
  WHATSAPP_INPUT_CHAR,
  WHATSAPP_INPUT_MAX_LENGTH,
} from '#/modules/lead-capture/domain/rules.ts';
import { codePointLength, normalizeText } from '#/modules/lead-capture/domain/text.ts';

const NON_DIGITS = /\D/g;
/** Mobile numbers only: a WhatsApp contact cannot be a landline. */
const ACCEPTED_NUMBER_TYPES: ReadonlySet<string | undefined> = new Set([
  'MOBILE',
  'FIXED_LINE_OR_MOBILE',
]);

/**
 * WhatsApp field (lead-capture §4.1, AC-LC-15): input ≤ 32 characters, only digits and phone
 * punctuation, optional leading `+`, default country BR, `libphonenumber-js` validity and mobile
 * type. Returns E.164 (`^\+[1-9]\d{7,14}$`). Never throws.
 */
export function parseWhatsapp(raw: unknown): Result<string, FieldErrorCode> {
  if (typeof raw !== 'string') {
    return err('invalid_format');
  }
  const normalized = normalizeText(raw);
  if (!normalized.ok) {
    return normalized;
  }
  const input = normalized.value;
  if (input === '') {
    return err('required');
  }
  if (codePointLength(input) > WHATSAPP_INPUT_MAX_LENGTH) {
    return err('too_long');
  }
  const hasLeadingPlus = input.startsWith('+');
  const body = hasLeadingPlus ? input.slice(1) : input;
  if (!Array.from(body).every((char) => char !== '+' && WHATSAPP_INPUT_CHAR.test(char))) {
    return err('invalid_format');
  }
  const digits = body.replace(NON_DIGITS, '');
  if (digits === '') {
    return err('invalid_format');
  }
  return toE164(`${hasLeadingPlus ? '+' : ''}${digits}`);
}

function toE164(candidate: string): Result<string, FieldErrorCode> {
  try {
    const parsed = parsePhoneNumberFromString(candidate, WHATSAPP_DEFAULT_COUNTRY);
    if (
      parsed?.isValid() !== true ||
      !ACCEPTED_NUMBER_TYPES.has(parsed.getType()) ||
      !E164_PATTERN.test(parsed.number)
    ) {
      return err('invalid_format');
    }
    return ok(parsed.number);
  } catch {
    return err('invalid_format');
  }
}
