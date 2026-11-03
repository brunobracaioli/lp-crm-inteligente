/**
 * Closed vocabularies shared by lead-capture (validation), crm (score) and the database CHECKs.
 * Source: lead-capture §4.1–4.2. Changing a list requires a migration (database §3.3).
 */
export const AREAS_OF_EXPERTISE = [
  'marketing_advertising',
  'technology',
  'ecommerce_retail',
  'infoproducts_creators',
  'health',
  'education',
  'finance',
  'real_estate',
  'industry',
  'professional_services',
  'legal',
  'agribusiness',
  'logistics',
  'food_hospitality',
  'construction',
  'public_sector_nonprofit',
  'other',
] as const;
export type AreaOfExpertise = (typeof AREAS_OF_EXPERTISE)[number];

export const COMPANY_SIZES = ['solo', '2_10', '11_50', '51_200', '201_1000', '1000_plus'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

/** Attribution captured with a submission; also the shape of crm first_touch/last_touch. */
export interface AttributionSnapshot {
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmTerm: string | null;
  readonly utmContent: string | null;
  readonly utmId: string | null;
  readonly gclid: string | null;
  readonly gbraid: string | null;
  readonly wbraid: string | null;
  readonly fbclid: string | null;
  readonly ttclid: string | null;
  readonly msclkid: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly gaClientId: string | null;
  readonly landingPageUrl: string | null;
  readonly referrerUrl: string | null;
}
