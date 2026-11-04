import type { ConsentState, ConsentValue } from '#/shared/consent.ts';
import {
  AREAS_OF_EXPERTISE,
  COMPANY_SIZES,
  type AreaOfExpertise,
  type AttributionSnapshot,
  type CompanySize,
} from '#/shared/lead-profile.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import { parseEmail } from '#/modules/lead-capture/domain/email.ts';
import {
  MAX_FIELD_ERRORS,
  type FieldError,
  type FieldErrorCode,
} from '#/modules/lead-capture/domain/field-error.ts';
import {
  FORM_KEY_PATTERN,
  TEXT_RULES,
  TRACKING_RULES,
  TURNSTILE_TOKEN_MAX_LENGTH,
  UUID_PATTERN,
  type TextRule,
} from '#/modules/lead-capture/domain/rules.ts';
import { codePointLength, readText } from '#/modules/lead-capture/domain/text.ts';
import { originOf, parseTrackingUrl, parseWebsite } from '#/modules/lead-capture/domain/url.ts';
import { parseWhatsapp } from '#/modules/lead-capture/domain/whatsapp.ts';

/** Fields needed before the Turnstile call (lead-capture §2, step 5). */
export interface SubmissionEnvelope {
  readonly formKey: string;
  readonly turnstileToken: string;
}

/**
 * The normalized, fully validated submission (lead-capture §4). It carries no Turnstile token, no
 * IP and no user agent. Optional fields are `null` when absent or blank.
 */
export interface SubmissionSnapshot {
  readonly formKey: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Lowercase. */
  readonly email: string;
  /** E.164. */
  readonly whatsappE164: string;
  readonly companyName: string;
  readonly areaOfExpertise: AreaOfExpertise;
  readonly areaOfExpertiseOther: string | null;
  readonly jobTitle: string | null;
  readonly companySize: CompanySize | null;
  readonly companyWebsite: string | null;
  readonly message: string | null;
  readonly marketingOptIn: boolean;
  readonly privacyConsent: true;
  readonly consent: ConsentState;
  readonly attribution: AttributionSnapshot;
  /** Client-supplied dedup id (valid UUID, lowercase) or null: the server generates one then. */
  readonly eventId: string | null;
}

export interface ValidatedSubmission {
  readonly snapshot: SubmissionSnapshot;
  /** `hp` was filled (R3). Never reported as a field error, so bots learn nothing. */
  readonly honeypotFilled: boolean;
}

export interface ParseSubmissionOptions {
  /** `form.allowed_origins`; a `landing_page_url` outside them is dropped, not rejected. */
  readonly allowedOrigins: readonly string[];
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'form_key',
  'turnstile_token',
  'first_name',
  'last_name',
  'email',
  'whatsapp',
  'company',
  'area_of_expertise',
  'area_of_expertise_other',
  'job_title',
  'company_size',
  'company_website',
  'message',
  'marketing_opt_in',
  'privacy_consent',
  'hp',
  'consent',
  'tracking',
]);

const CONSENT_KEYS = [
  'analytics_storage',
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
] as const;

const TRACKING_KEYS: ReadonlySet<string> = new Set([
  'event_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'ttclid',
  'msclkid',
  'fbp',
  'fbc',
  'ga_client_id',
  'landing_page_url',
  'referrer_url',
]);

const CONSENT_VALUES: readonly ConsentValue[] = ['granted', 'denied'];
const REFLECTABLE_KEY = /^[A-Za-z0-9_]{1,40}$/;
const UNKNOWN_FIELD_PLACEHOLDER = '_unknown';

export const ALL_DENIED_CONSENT: ConsentState = {
  analyticsStorage: 'denied',
  adStorage: 'denied',
  adUserData: 'denied',
  adPersonalization: 'denied',
};

// ---------------------------------------------------------------------------
// Reading helpers

type RawObject = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): RawObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawObject)
    : null;
}

function read(record: RawObject, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** `null` and `undefined` both mean "not provided". */
function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

interface ErrorCollector {
  add(field: string, code: FieldErrorCode): void;
  /** Unwraps a field result; on failure records the error and returns `fallback`. */
  take<T>(field: string, result: Result<T, FieldErrorCode>, fallback: T): T;
  readonly list: readonly FieldError[];
}

function createErrorCollector(): ErrorCollector {
  const list: FieldError[] = [];
  const add = (field: string, code: FieldErrorCode): void => {
    if (list.length < MAX_FIELD_ERRORS) {
      list.push({ field, code });
    }
  };
  return {
    add,
    take: (field, result, fallback) => {
      if (result.ok) {
        return result.value;
      }
      add(field, result.error);
      return fallback;
    },
    list,
  };
}

function readRequired<T>(
  raw: unknown,
  parse: (value: unknown) => Result<T, FieldErrorCode>,
): Result<T, FieldErrorCode> {
  return isAbsent(raw) ? err('required') : parse(raw);
}

/** Absent or blank (`required` from the parser) becomes `null`; any other failure is kept. */
function readOptional<T>(
  raw: unknown,
  parse: (value: unknown) => Result<T, FieldErrorCode>,
): Result<T | null, FieldErrorCode> {
  if (isAbsent(raw)) {
    return ok(null);
  }
  const parsed = parse(raw);
  if (parsed.ok) {
    return parsed;
  }
  return parsed.error === 'required' ? ok(null) : parsed;
}

const textParser =
  (rule: TextRule, multiline = false) =>
  (value: unknown): Result<string, FieldErrorCode> =>
    readText(value, rule, multiline);

function enumParser<T extends string>(values: readonly T[]) {
  return (value: unknown): Result<T, FieldErrorCode> => {
    if (typeof value !== 'string') {
      return err('invalid_format');
    }
    if (value.trim() === '') {
      return err('required');
    }
    const match = values.find((candidate) => candidate === value);
    return match === undefined ? err('invalid_choice') : ok(match);
  };
}

const parseAreaOfExpertise = enumParser<AreaOfExpertise>(AREAS_OF_EXPERTISE);
const parseCompanySize = enumParser<CompanySize>(COMPANY_SIZES);
const parseConsentValue = enumParser<ConsentValue>(CONSENT_VALUES);

function parseBoolean(value: unknown): Result<boolean, FieldErrorCode> {
  return typeof value === 'boolean' ? ok(value) : err('invalid_format');
}

function reflectableFieldName(key: string): string {
  return REFLECTABLE_KEY.test(key) ? key : UNKNOWN_FIELD_PLACEHOLDER;
}

function rejectUnknownKeys(
  record: RawObject,
  known: ReadonlySet<string>,
  prefix: string,
  errors: ErrorCollector,
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      errors.add(`${prefix}${reflectableFieldName(key)}`, 'not_allowed');
    }
  }
}

// ---------------------------------------------------------------------------
// Envelope (step 5)

function parseFormKey(value: unknown): Result<string, FieldErrorCode> {
  if (typeof value !== 'string') {
    return err('invalid_format');
  }
  if (value === '') {
    return err('required');
  }
  return FORM_KEY_PATTERN.test(value) ? ok(value) : err('invalid_format');
}

/** The Turnstile token is opaque: it is never trimmed or normalized, only bounded. */
function parseTurnstileToken(value: unknown): Result<string, FieldErrorCode> {
  if (typeof value !== 'string') {
    return err('invalid_format');
  }
  if (value === '') {
    return err('required');
  }
  return codePointLength(value) > TURNSTILE_TOKEN_MAX_LENGTH ? err('too_long') : ok(value);
}

/**
 * Minimal validation before the form lookup and the Turnstile call: only `form_key` and
 * `turnstile_token`. The full schema runs after human proof (`parseSubmission`).
 */
export function parseEnvelope(body: unknown): Result<SubmissionEnvelope, readonly FieldError[]> {
  const record = asRecord(body) ?? {};
  const errors = createErrorCollector();
  const formKey = errors.take('form_key', readRequired(read(record, 'form_key'), parseFormKey), '');
  const turnstileToken = errors.take(
    'turnstile_token',
    readRequired(read(record, 'turnstile_token'), parseTurnstileToken),
    '',
  );
  return errors.list.length > 0 ? err(errors.list) : ok({ formKey, turnstileToken });
}

// ---------------------------------------------------------------------------
// Consent and tracking sub-objects

function parseConsent(raw: unknown, errors: ErrorCollector): ConsentState {
  if (isAbsent(raw)) {
    return ALL_DENIED_CONSENT;
  }
  const record = asRecord(raw);
  if (record === null) {
    errors.add('consent', 'invalid_format');
    return ALL_DENIED_CONSENT;
  }
  rejectUnknownKeys(record, new Set(CONSENT_KEYS), 'consent.', errors);
  const value = (key: (typeof CONSENT_KEYS)[number]): ConsentValue =>
    errors.take(`consent.${key}`, readOptional(read(record, key), parseConsentValue), null) ??
    'denied';
  return {
    analyticsStorage: value('analytics_storage'),
    adStorage: value('ad_storage'),
    adUserData: value('ad_user_data'),
    adPersonalization: value('ad_personalization'),
  };
}

const EMPTY_ATTRIBUTION: AttributionSnapshot = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  utmId: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
  fbclid: null,
  ttclid: null,
  msclkid: null,
  fbp: null,
  fbc: null,
  gaClientId: null,
  landingPageUrl: null,
  referrerUrl: null,
};

interface ParsedTracking {
  readonly attribution: AttributionSnapshot;
  readonly eventId: string | null;
}

function parseTracking(
  raw: unknown,
  allowedOrigins: readonly string[],
  errors: ErrorCollector,
): ParsedTracking {
  if (isAbsent(raw)) {
    return { attribution: EMPTY_ATTRIBUTION, eventId: null };
  }
  const record = asRecord(raw);
  if (record === null) {
    errors.add('tracking', 'invalid_format');
    return { attribution: EMPTY_ATTRIBUTION, eventId: null };
  }
  rejectUnknownKeys(record, TRACKING_KEYS, 'tracking.', errors);

  const text = (key: string, rule: TextRule): string | null =>
    errors.take(`tracking.${key}`, readOptional(read(record, key), textParser(rule)), null);
  const utm = (key: string): string | null => text(key, TRACKING_RULES.utm);
  const clickId = (key: string): string | null => text(key, TRACKING_RULES.clickId);

  const landingPageUrl = errors.take(
    'tracking.landing_page_url',
    readOptional(read(record, 'landing_page_url'), parseTrackingUrl),
    null,
  );
  const landingOrigin = landingPageUrl === null ? null : originOf(landingPageUrl);
  const attribution: AttributionSnapshot = {
    utmSource: utm('utm_source'),
    utmMedium: utm('utm_medium'),
    utmCampaign: utm('utm_campaign'),
    utmTerm: utm('utm_term'),
    utmContent: utm('utm_content'),
    utmId: utm('utm_id'),
    gclid: clickId('gclid'),
    gbraid: clickId('gbraid'),
    wbraid: clickId('wbraid'),
    fbclid: clickId('fbclid'),
    ttclid: clickId('ttclid'),
    msclkid: clickId('msclkid'),
    fbp: text('fbp', TRACKING_RULES.metaBrowserId),
    fbc: text('fbc', TRACKING_RULES.metaBrowserId),
    gaClientId: text('ga_client_id', TRACKING_RULES.gaClientId),
    // A landing page outside the form's origins is discarded, not rejected (§4.1).
    landingPageUrl:
      landingOrigin !== null && allowedOrigins.includes(landingOrigin) ? landingPageUrl : null,
    referrerUrl: errors.take(
      'tracking.referrer_url',
      readOptional(read(record, 'referrer_url'), parseTrackingUrl),
      null,
    ),
  };
  return { attribution, eventId: parseClientEventId(read(record, 'event_id')) };
}

/** An absent or malformed `event_id` is not an error: the server generates one (§4.1). */
function parseClientEventId(raw: unknown): string | null {
  return typeof raw === 'string' && UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Full submission (step 7)

function isHoneypotFilled(raw: unknown): boolean {
  return typeof raw === 'string' ? raw.length > 0 : !isAbsent(raw);
}

/**
 * Full validation and normalization of the request body (lead-capture §4). Collects every field
 * error (at most 50), rejects unknown keys (`not_allowed`, anti mass-assignment, AC-LC-11) and
 * never throws, whatever the input (AC-LC-13).
 */
export function parseSubmission(
  body: unknown,
  options: ParseSubmissionOptions,
): Result<ValidatedSubmission, readonly FieldError[]> {
  const record = asRecord(body) ?? {};
  const errors = createErrorCollector();
  rejectUnknownKeys(record, TOP_LEVEL_KEYS, '', errors);

  const formKey = errors.take('form_key', readRequired(read(record, 'form_key'), parseFormKey), '');
  errors.take(
    'turnstile_token',
    readRequired(read(record, 'turnstile_token'), parseTurnstileToken),
    '',
  );
  const firstName = errors.take(
    'first_name',
    readRequired(read(record, 'first_name'), textParser(TEXT_RULES.firstName)),
    '',
  );
  const lastName = errors.take(
    'last_name',
    readRequired(read(record, 'last_name'), textParser(TEXT_RULES.lastName)),
    '',
  );
  const email = errors.take('email', readRequired(read(record, 'email'), parseEmail), '');
  const whatsappE164 = errors.take(
    'whatsapp',
    readRequired(read(record, 'whatsapp'), parseWhatsapp),
    '',
  );
  const companyName = errors.take(
    'company',
    readRequired(read(record, 'company'), textParser(TEXT_RULES.company)),
    '',
  );

  const area = errors.take(
    'area_of_expertise',
    readRequired(read(record, 'area_of_expertise'), parseAreaOfExpertise),
    null,
  );
  const otherResult = readOptional(
    read(record, 'area_of_expertise_other'),
    textParser(TEXT_RULES.areaOfExpertiseOther),
  );
  let areaOfExpertiseOther: string | null = null;
  if (!otherResult.ok) {
    errors.add('area_of_expertise_other', otherResult.error);
  } else if (area === 'other' && otherResult.value === null) {
    errors.add('area_of_expertise_other', 'required');
  } else if (area !== null && area !== 'other' && otherResult.value !== null) {
    errors.add('area_of_expertise_other', 'invalid_format');
  } else {
    areaOfExpertiseOther = otherResult.value;
  }

  const jobTitle = errors.take(
    'job_title',
    readOptional(read(record, 'job_title'), textParser(TEXT_RULES.jobTitle)),
    null,
  );
  const companySize = errors.take(
    'company_size',
    readOptional(read(record, 'company_size'), parseCompanySize),
    null,
  );
  const companyWebsite = errors.take(
    'company_website',
    readOptional(read(record, 'company_website'), parseWebsite),
    null,
  );
  const message = errors.take(
    'message',
    readOptional(read(record, 'message'), textParser(TEXT_RULES.message, true)),
    null,
  );
  const marketingOptIn = errors.take(
    'marketing_opt_in',
    readOptional(read(record, 'marketing_opt_in'), parseBoolean),
    null,
  );

  const privacyRaw = read(record, 'privacy_consent');
  if (isAbsent(privacyRaw)) {
    errors.add('privacy_consent', 'required');
  } else if (typeof privacyRaw !== 'boolean') {
    errors.add('privacy_consent', 'invalid_format');
  } else if (!privacyRaw) {
    errors.add('privacy_consent', 'must_be_true');
  }

  const consent = parseConsent(read(record, 'consent'), errors);
  const tracking = parseTracking(read(record, 'tracking'), options.allowedOrigins, errors);

  if (errors.list.length > 0 || area === null) {
    return err(errors.list);
  }
  return ok({
    honeypotFilled: isHoneypotFilled(read(record, 'hp')),
    snapshot: {
      formKey,
      firstName,
      lastName,
      email,
      whatsappE164,
      companyName,
      areaOfExpertise: area,
      areaOfExpertiseOther,
      jobTitle,
      companySize,
      companyWebsite,
      message,
      marketingOptIn: marketingOptIn ?? false,
      privacyConsent: true,
      consent,
      attribution: tracking.attribution,
      eventId: tracking.eventId,
    },
  });
}

/**
 * Normalized form fields stored in `capture.submissions.fields` (database §3.4). `message` and
 * the attribution have their own columns; the Turnstile token is never persisted.
 */
export function submissionFields(
  snapshot: SubmissionSnapshot,
): Readonly<Record<string, string | boolean | null>> {
  return {
    first_name: snapshot.firstName,
    last_name: snapshot.lastName,
    email: snapshot.email,
    whatsapp: snapshot.whatsappE164,
    company: snapshot.companyName,
    area_of_expertise: snapshot.areaOfExpertise,
    area_of_expertise_other: snapshot.areaOfExpertiseOther,
    job_title: snapshot.jobTitle,
    company_size: snapshot.companySize,
    company_website: snapshot.companyWebsite,
    marketing_opt_in: snapshot.marketingOptIn,
    privacy_consent: snapshot.privacyConsent,
  };
}
