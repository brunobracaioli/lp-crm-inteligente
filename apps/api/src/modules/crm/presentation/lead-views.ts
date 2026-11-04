import type { LeadDetail } from '#/modules/crm/application/queries/get-lead-detail.ts';
import type { LeadPage } from '#/modules/crm/application/queries/list-leads.ts';
import type {
  ActivityView,
  AttributionSummaryView,
  ConsentStateView,
  ConsentView,
  LeadProfileView,
  LeadSummaryView,
  SubmissionFieldsView,
  SubmissionView,
} from '#/modules/crm/application/queries/ports.ts';

/**
 * Read models → the contract's JSON (snake_case, ISO 8601 timestamps). Optional contract properties
 * are omitted when unknown instead of being sent as `null`, so the payload stays minimal.
 */

type Json = Readonly<Record<string, unknown>>;

/** Keeps only the entries whose value is not null. */
function present(entries: Readonly<Record<string, unknown>>): Json {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== null));
}

export function leadSummaryJson(lead: LeadSummaryView): Json {
  return {
    id: lead.id,
    first_name: lead.firstName,
    last_name: lead.lastName,
    email: lead.email,
    company_name: lead.companyName,
    job_title: lead.jobTitle,
    area_of_expertise: lead.areaOfExpertise,
    company_size: lead.companySize,
    stage: lead.stage,
    lost_reason: lead.lostReason,
    score: lead.score,
    score_band: lead.scoreBand,
    owner_user_id: lead.ownerUserId,
    submissions_count: lead.submissionsCount,
    first_submitted_at: lead.firstSubmittedAt.toISOString(),
    last_submitted_at: lead.lastSubmittedAt.toISOString(),
    created_at: lead.createdAt.toISOString(),
    updated_at: lead.updatedAt.toISOString(),
    anonymized_at: lead.anonymizedAt === null ? null : lead.anonymizedAt.toISOString(),
    version: lead.version,
  };
}

export function leadProfileJson(lead: LeadProfileView): Json {
  return {
    ...leadSummaryJson(lead),
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

export function attributionJson(attribution: AttributionSummaryView): Json {
  return {
    ...present({
      utm_source: attribution.utmSource,
      utm_medium: attribution.utmMedium,
      utm_campaign: attribution.utmCampaign,
      utm_term: attribution.utmTerm,
      utm_content: attribution.utmContent,
      utm_id: attribution.utmId,
      landing_page_url: attribution.landingPageUrl,
      referrer_url: attribution.referrerUrl,
    }),
    click_id_types: attribution.clickIdTypes,
  };
}

function submissionFieldsJson(fields: SubmissionFieldsView): Json {
  return present({
    first_name: fields.firstName,
    last_name: fields.lastName,
    email: fields.email,
    whatsapp: fields.whatsapp,
    company: fields.company,
    area_of_expertise: fields.areaOfExpertise,
    area_of_expertise_other: fields.areaOfExpertiseOther,
    job_title: fields.jobTitle,
    company_size: fields.companySize,
    company_website: fields.companyWebsite,
    marketing_opt_in: fields.marketingOptIn,
  });
}

function consentStateJson(state: ConsentStateView): Json {
  return present({
    analytics_storage: state.analyticsStorage,
    ad_storage: state.adStorage,
    ad_user_data: state.adUserData,
    ad_personalization: state.adPersonalization,
  });
}

export function submissionJson(submission: SubmissionView): Json {
  return {
    id: submission.id,
    created_at: submission.createdAt.toISOString(),
    fields: submissionFieldsJson(submission.fields),
    message: submission.message,
    attribution: attributionJson(submission.attribution),
    consent_state: consentStateJson(submission.consentState),
  };
}

export function consentJson(consent: ConsentView): Json {
  return {
    purpose: consent.purpose,
    granted: consent.granted,
    policy_version: consent.policyVersion,
    recorded_at: consent.recordedAt.toISOString(),
  };
}

export function activityJson(activity: ActivityView): Json {
  return {
    id: activity.id,
    type: activity.type,
    actor_type: activity.actorType,
    actor_id: activity.actorId,
    created_at: activity.createdAt.toISOString(),
    data: activity.data,
  };
}

export function leadPageJson(page: LeadPage): Json {
  return { items: page.items.map(leadSummaryJson), next_cursor: page.nextCursor };
}

export function leadDetailJson(detail: LeadDetail): Json {
  return {
    lead: leadProfileJson(detail.lead),
    first_touch: attributionJson(detail.firstTouch),
    last_touch: attributionJson(detail.lastTouch),
    submissions: detail.submissions.map(submissionJson),
    consents: detail.consents.map(consentJson),
    activities: {
      items: detail.activities.items.map(activityJson),
      next_cursor: detail.activities.nextCursor,
    },
  };
}
