import type { Brand } from '#/shared/ids.ts';
import {
  AREAS_OF_EXPERTISE,
  COMPANY_SIZES,
  type AreaOfExpertise,
  type CompanySize,
} from '#/shared/lead-profile.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import { domainError, type DomainError } from '#/modules/crm/domain/errors.ts';

/**
 * Value objects of the Lead aggregate (crm §3). They check the invariants the database CHECKs
 * enforce (database §3.3). The full, user-facing field rules live in lead-capture (§4): the crm
 * trusts the edge but never persists a value it has not re-checked, so a contract violation
 * between the modules fails loudly instead of reaching a CHECK constraint.
 */

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedAndTrimmed(value: string, min: number, max: number): boolean {
  const length = codePointLength(value);
  return value === value.trim() && length >= min && length <= max;
}

// ---------------------------------------------------------------------------
export type Email = Brand<string, 'Email'>;

const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const Email = {
  /** Expects the lowercase, trimmed address produced by lead-capture. */
  parse(raw: string): Result<Email, DomainError> {
    const valid =
      raw === raw.toLowerCase() &&
      codePointLength(raw) <= EMAIL_MAX_LENGTH &&
      EMAIL_SHAPE.test(raw);
    return valid ? ok(raw as Email) : err(domainError('invalid_email'));
  },
};

// ---------------------------------------------------------------------------
export type PhoneE164 = Brand<string, 'PhoneE164'>;

const E164_SHAPE = /^\+[1-9][0-9]{7,14}$/;

export const PhoneE164 = {
  parse(raw: string): Result<PhoneE164, DomainError> {
    return E164_SHAPE.test(raw) ? ok(raw as PhoneE164) : err(domainError('invalid_whatsapp'));
  },
};

// ---------------------------------------------------------------------------
export interface PersonName {
  readonly first: string;
  readonly last: string;
}

const FIRST_NAME_MAX_LENGTH = 60;
const LAST_NAME_MAX_LENGTH = 80;

export const PersonName = {
  parse(first: string, last: string): Result<PersonName, DomainError> {
    return isBoundedAndTrimmed(first, 1, FIRST_NAME_MAX_LENGTH) &&
      isBoundedAndTrimmed(last, 1, LAST_NAME_MAX_LENGTH)
      ? ok({ first, last })
      : err(domainError('invalid_person_name'));
  },
};

// ---------------------------------------------------------------------------
export interface CompanyProfile {
  readonly name: string;
  readonly area: AreaOfExpertise;
  readonly areaOther: string | null;
  readonly size: CompanySize | null;
  readonly website: string | null;
  readonly jobTitle: string | null;
}

export interface CompanyProfileInput {
  readonly name: string;
  readonly area: string;
  readonly areaOther: string | null;
  readonly size: string | null;
  readonly website: string | null;
  readonly jobTitle: string | null;
}

const COMPANY_NAME_LIMITS = { min: 2, max: 120 } as const;
const AREA_OTHER_LIMITS = { min: 2, max: 80 } as const;
const JOB_TITLE_LIMITS = { min: 2, max: 100 } as const;
const WEBSITE_MAX_LENGTH = 200;
const WEBSITE_SHAPE = /^https?:\/\//;

function findOption<T extends string>(options: readonly T[], value: string): T | undefined {
  return options.find((option) => option === value);
}

function isBoundedOrNull(
  value: string | null,
  limits: { readonly min: number; readonly max: number },
): boolean {
  return value === null || isBoundedAndTrimmed(value, limits.min, limits.max);
}

export const CompanyProfile = {
  /** The database CHECK `(area = 'other') = (area_other IS NOT NULL)` is an invariant here. */
  parse(input: CompanyProfileInput): Result<CompanyProfile, DomainError> {
    const area = findOption(AREAS_OF_EXPERTISE, input.area);
    const size = input.size === null ? null : findOption(COMPANY_SIZES, input.size);
    const websiteValid =
      input.website === null ||
      (WEBSITE_SHAPE.test(input.website) && codePointLength(input.website) <= WEBSITE_MAX_LENGTH);
    const valid =
      area !== undefined &&
      size !== undefined &&
      isBoundedAndTrimmed(input.name, COMPANY_NAME_LIMITS.min, COMPANY_NAME_LIMITS.max) &&
      (area === 'other') === (input.areaOther !== null) &&
      isBoundedOrNull(input.areaOther, AREA_OTHER_LIMITS) &&
      isBoundedOrNull(input.jobTitle, JOB_TITLE_LIMITS) &&
      websiteValid;
    return valid
      ? ok({
          name: input.name,
          area,
          areaOther: input.areaOther,
          size,
          website: input.website,
          jobTitle: input.jobTitle,
        })
      : err(domainError('invalid_company_profile'));
  },
};
