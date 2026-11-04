import type {
  SubjectActivity,
  SubjectSubmission,
} from '#/modules/crm/application/commands/ports.ts';
import type { LeadSubjectExport } from '#/modules/crm/application/commands/export-lead-data.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import {
  leadSummaryView,
  type LeadSummaryView,
} from '#/modules/crm/presentation/mutation-views.ts';
import type { AttributionSnapshot } from '#/shared/lead-profile.ts';

/**
 * Wire shape of the LGPD right-of-access export (contract `LeadDataExport`). Every object is built
 * from an explicit whitelist: the contract's schemas are closed, and a column or JSON key that is
 * not named here (e.g. `privacy_consent` in the stored form fields) never reaches the titular.
 */

const SCHEMA_VERSION = '1';

const SUBMISSION_FIELD_KEYS = [
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
  'marketing_opt_in',
] as const;

const CONSENT_KEYS = [
  'analytics_storage',
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
] as const;

type Json = Readonly<Record<string, unknown>>;

function pick(source: Json, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) {
      picked[key] = source[key];
    }
  }
  return picked;
}

/** Omits unknown (null) values: an absent key means "not captured". */
function present(entries: Readonly<Record<string, string | null>>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null) {
      output[key] = value;
    }
  }
  return output;
}

function attributionFull(touch: AttributionSnapshot): Record<string, string> {
  return present({
    utm_source: touch.utmSource,
    utm_medium: touch.utmMedium,
    utm_campaign: touch.utmCampaign,
    utm_term: touch.utmTerm,
    utm_content: touch.utmContent,
    utm_id: touch.utmId,
    gclid: touch.gclid,
    gbraid: touch.gbraid,
    wbraid: touch.wbraid,
    fbclid: touch.fbclid,
    ttclid: touch.ttclid,
    msclkid: touch.msclkid,
    fbp: touch.fbp,
    fbc: touch.fbc,
    ga_client_id: touch.gaClientId,
    landing_page_url: touch.landingPageUrl,
    referrer_url: touch.referrerUrl,
  });
}

function submissionView(submission: SubjectSubmission): Record<string, unknown> {
  return {
    id: submission.id,
    created_at: submission.createdAt.toISOString(),
    fields: pick(submission.fields, SUBMISSION_FIELD_KEYS),
    message: submission.message,
    tracking: present({
      utm_source: submission.utmSource,
      utm_medium: submission.utmMedium,
      utm_campaign: submission.utmCampaign,
      utm_term: submission.utmTerm,
      utm_content: submission.utmContent,
      utm_id: submission.utmId,
      gclid: submission.gclid,
      gbraid: submission.gbraid,
      wbraid: submission.wbraid,
      fbclid: submission.fbclid,
      ttclid: submission.ttclid,
      msclkid: submission.msclkid,
      fbp: submission.fbp,
      fbc: submission.fbc,
      ga_client_id: submission.gaClientId,
      landing_page_url: submission.landingPageUrl,
      referrer_url: submission.referrerUrl,
    }),
    consent_state: pick(submission.consentState, CONSENT_KEYS),
    client_ip: submission.clientIp,
    user_agent: submission.userAgent,
  };
}

/**
 * The timeline payloads are stored with the keys of `lead-activities.ts`; the contract names them
 * differently (`ActivityData`), so each type is mapped explicitly and unknown keys are dropped.
 */
function activityDataView(activity: SubjectActivity): Record<string, unknown> {
  const { data } = activity;
  switch (activity.type) {
    case 'submission_received':
      return pick(data, ['submission_id']);
    case 'stage_changed':
      return {
        from_stage: data.from,
        to_stage: data.to,
        ...(typeof data.lost_reason === 'string' ? { lost_reason: data.lost_reason } : {}),
      };
    case 'owner_assigned':
      return {
        from_owner_user_id: data.previous_owner_id ?? null,
        to_owner_user_id: data.owner_id ?? null,
      };
    case 'note_added':
      return pick(data, ['body']);
    case 'score_changed':
      return {
        from_band: data.from_band,
        to_band: data.to_band,
        ...(typeof data.score === 'number' ? { to_score: data.score } : {}),
      };
    case 'conversion_sent':
      return pick(data, ['destination']);
    case 'insight_generated':
      return pick(data, ['insight_id']);
    case 'anonymized':
      return {};
  }
}

function activityView(activity: SubjectActivity): Record<string, unknown> {
  return {
    id: activity.id,
    type: activity.type,
    actor_type: activity.actorType,
    actor_id: activity.actorId,
    created_at: activity.createdAt.toISOString(),
    data: activityDataView(activity),
  };
}

export interface LeadProfileView extends LeadSummaryView {
  readonly whatsapp: string;
  readonly area_of_expertise_other: string | null;
  readonly company_website: string | null;
  readonly marketing_opt_in: boolean;
  readonly score_breakdown: readonly { readonly rule_id: string; readonly points: number }[];
}

function leadProfileView(lead: LeadState): LeadProfileView {
  return {
    ...leadSummaryView(lead),
    whatsapp: lead.whatsappE164,
    area_of_expertise_other: lead.areaOfExpertiseOther,
    company_website: lead.companyWebsite,
    marketing_opt_in: lead.marketingOptIn,
    score_breakdown: lead.scoreBreakdown.map((item) => ({
      rule_id: item.ruleId,
      points: item.points,
    })),
  };
}

export function leadDataExportView(exported: LeadSubjectExport): Record<string, unknown> {
  const { lead, data } = exported;
  return {
    schema_version: SCHEMA_VERSION,
    exported_at: exported.exportedAt.toISOString(),
    truncated: data.truncated,
    lead: leadProfileView(lead),
    first_touch: attributionFull(lead.firstTouch),
    last_touch: attributionFull(lead.lastTouch),
    submissions: data.submissions.map(submissionView),
    consents: data.consents.map((consent) => ({
      purpose: consent.purpose,
      granted: consent.granted,
      policy_version: consent.policyVersion,
      recorded_at: consent.recordedAt.toISOString(),
    })),
    activities: data.activities.map(activityView),
  };
}
