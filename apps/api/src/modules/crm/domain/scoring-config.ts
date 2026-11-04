import type { AreaOfExpertise, CompanySize } from '#/shared/lead-profile.ts';

/**
 * Score v1 weights and defaults (crm §5). The ICP (open question Q2) is a placeholder until the
 * workspace configures `core.workspaces.settings.icp`; weights are constants in v1.
 */

export const SCORE_RULE_IDS = {
  companySize: 'fit_company_size',
  segment: 'fit_segment',
  seniority: 'fit_seniority',
  corporateEmail: 'fit_corporate_email',
  message: 'intent_message',
  website: 'intent_website',
  paidOrigin: 'intent_paid_origin',
  recurrence: 'intent_recurrence',
} as const;

export const COMPANY_SIZE_POINTS: Readonly<Record<CompanySize, number>> = {
  solo: 0,
  '2_10': 8,
  '11_50': 15,
  '51_200': 20,
  '201_1000': 20,
  '1000_plus': 15,
};

export const SEGMENT_POINTS = { priority: 15, secondary: 8 } as const;
export const SENIORITY_POINTS = 15;
export const CORPORATE_EMAIL_POINTS = 10;
export const MESSAGE_POINTS = 10;
export const WEBSITE_POINTS = 5;
export const PAID_ORIGIN_POINTS = 10;
export const RECURRENCE_POINTS = 15;

/** `message` counts as intent from this many characters (code points). */
export const MESSAGE_MIN_LENGTH = 40;
/** Recurrence counts from this many submissions. */
export const RECURRENCE_MIN_SUBMISSIONS = 2;

export const MAX_SCORE = 100;
/** Band A when score ≥ 70, B from 40, otherwise C. */
export const BAND_A_MIN_SCORE = 70;
export const BAND_B_MIN_SCORE = 40;

/** Ideal customer profile; structurally identical to the `IcpSettings` port of the application. */
export interface IcpProfile {
  readonly priorityAreas: readonly AreaOfExpertise[];
  readonly secondaryAreas: readonly AreaOfExpertise[];
  /** Lowercase, no accents; matched at the start of a word of the job title. */
  readonly seniorTitlePatterns: readonly string[];
}

export const DEFAULT_ICP: IcpProfile = {
  priorityAreas: ['marketing_advertising', 'ecommerce_retail', 'infoproducts_creators'],
  secondaryAreas: ['technology', 'professional_services', 'real_estate', 'education'],
  seniorTitlePatterns: [
    'ceo',
    'cto',
    'cfo',
    'cmo',
    'coo',
    'c-level',
    'fundador',
    'cofundador',
    'founder',
    'socio',
    'dono',
    'proprietario',
    'presidente',
    'diretor',
    'head',
    'gerente',
  ],
};

/** Personal webmail providers: a corporate e-mail domain is any domain outside this list. */
export const WEBMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.com.br',
  'outlook.com',
  'outlook.com.br',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.com.br',
  'icloud.com',
  'me.com',
  'mac.com',
  'bol.com.br',
  'uol.com.br',
  'terra.com.br',
  'ig.com.br',
  'globo.com',
  'globomail.com',
  'r7.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
]);
