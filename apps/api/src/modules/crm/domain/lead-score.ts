import type { AreaOfExpertise, CompanySize } from '#/shared/lead-profile.ts';
import type { ScoreBand, ScoreContribution } from '#/modules/crm/domain/lead-types.ts';
import {
  BAND_A_MIN_SCORE,
  BAND_B_MIN_SCORE,
  COMPANY_SIZE_POINTS,
  CORPORATE_EMAIL_POINTS,
  DEFAULT_ICP,
  MAX_SCORE,
  MESSAGE_MIN_LENGTH,
  MESSAGE_POINTS,
  PAID_ORIGIN_POINTS,
  RECURRENCE_MIN_SUBMISSIONS,
  RECURRENCE_POINTS,
  SCORE_RULE_IDS,
  SEGMENT_POINTS,
  SENIORITY_POINTS,
  WEBMAIL_DOMAINS,
  WEBSITE_POINTS,
  type IcpProfile,
} from '#/modules/crm/domain/scoring-config.ts';

/** Profile facts the score reads (the current merged lead data plus this submission's message). */
export interface ScoreProfile {
  readonly companySize: CompanySize | null;
  readonly areaOfExpertise: AreaOfExpertise;
  readonly jobTitle: string | null;
  /** Lowercase address. */
  readonly email: string;
  readonly message: string | null;
  readonly companyWebsite: string | null;
}

/** Behavioural signals of the lead. */
export interface ScoreSignals {
  readonly submissionsCount: number;
  /** A paid-media click id (gclid/gbraid/wbraid/fbclid) on the first or the latest touch. */
  readonly paidOrigin: boolean;
}

export interface LeadScore {
  /** `min(100, rawTotal)`. */
  readonly value: number;
  readonly band: ScoreBand;
  /** Only the rules that contributed (points > 0); sums to `rawTotal` (explainability). */
  readonly breakdown: readonly ScoreContribution[];
  /** Sum of the breakdown before the cap. */
  readonly rawTotal: number;
}

const DIACRITICS = /\p{M}/gu;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Lowercase and strip accents so "Sócio" and "socio" match. */
export function normalizeForMatching(text: string): string {
  return text.normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

function matchesSeniority(jobTitle: string, patterns: readonly string[]): boolean {
  const title = normalizeForMatching(jobTitle);
  return patterns.some((pattern) => {
    const normalized = normalizeForMatching(pattern).trim();
    if (normalized === '') {
      return false;
    }
    const escaped = normalized.replace(REGEX_SPECIAL, '\\$&');
    // Start of a word: "diretor" matches "Diretora Comercial", "head" does not match "overhead".
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, 'u').test(title);
  });
}

function isCorporateEmail(email: string): boolean {
  return !WEBMAIL_DOMAINS.has(email.slice(email.lastIndexOf('@') + 1));
}

export function bandFor(value: number): ScoreBand {
  if (value >= BAND_A_MIN_SCORE) {
    return 'A';
  }
  return value >= BAND_B_MIN_SCORE ? 'B' : 'C';
}

function contribution(ruleId: string, points: number): readonly ScoreContribution[] {
  return points > 0 ? [{ ruleId, points }] : [];
}

function segmentPoints(area: AreaOfExpertise, icp: IcpProfile): number {
  if (icp.priorityAreas.includes(area)) {
    return SEGMENT_POINTS.priority;
  }
  return icp.secondaryAreas.includes(area) ? SEGMENT_POINTS.secondary : 0;
}

/**
 * Score v1 (crm §5): a pure, deterministic function of the profile, the signals and the ICP.
 * Same input, same output; `value ∈ [0, 100]`; the breakdown sums to the uncapped total.
 * A null ICP (workspace without settings) falls back to `DEFAULT_ICP`.
 */
export function scoreLead(
  profile: ScoreProfile,
  signals: ScoreSignals,
  icp: IcpProfile | null = null,
): LeadScore {
  const config = icp ?? DEFAULT_ICP;
  const breakdown: readonly ScoreContribution[] = [
    ...contribution(
      SCORE_RULE_IDS.companySize,
      profile.companySize === null ? 0 : COMPANY_SIZE_POINTS[profile.companySize],
    ),
    ...contribution(SCORE_RULE_IDS.segment, segmentPoints(profile.areaOfExpertise, config)),
    ...contribution(
      SCORE_RULE_IDS.seniority,
      profile.jobTitle !== null && matchesSeniority(profile.jobTitle, config.seniorTitlePatterns)
        ? SENIORITY_POINTS
        : 0,
    ),
    ...contribution(
      SCORE_RULE_IDS.corporateEmail,
      isCorporateEmail(profile.email) ? CORPORATE_EMAIL_POINTS : 0,
    ),
    ...contribution(
      SCORE_RULE_IDS.message,
      profile.message !== null && Array.from(profile.message).length >= MESSAGE_MIN_LENGTH
        ? MESSAGE_POINTS
        : 0,
    ),
    ...contribution(SCORE_RULE_IDS.website, profile.companyWebsite === null ? 0 : WEBSITE_POINTS),
    ...contribution(SCORE_RULE_IDS.paidOrigin, signals.paidOrigin ? PAID_ORIGIN_POINTS : 0),
    ...contribution(
      SCORE_RULE_IDS.recurrence,
      signals.submissionsCount >= RECURRENCE_MIN_SUBMISSIONS ? RECURRENCE_POINTS : 0,
    ),
  ];
  const rawTotal = breakdown.reduce((total, rule) => total + rule.points, 0);
  const value = Math.min(MAX_SCORE, rawTotal);
  return { value, band: bandFor(value), breakdown, rawTotal };
}
