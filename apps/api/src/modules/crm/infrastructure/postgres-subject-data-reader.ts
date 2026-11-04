import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { LeadId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  SubjectActivity,
  SubjectConsent,
  SubjectDataBundle,
  SubjectDataReader,
  SubjectSubmission,
} from '#/modules/crm/application/commands/ports.ts';
import { LEAD_ACTIVITY_TYPES } from '#/modules/crm/domain/lead-types.ts';

/** Caps of the data-subject export (contract `LeadDataExport`); one extra row detects the cut. */
export const SUBJECT_EXPORT_MAX_SUBMISSIONS = 50;
export const SUBJECT_EXPORT_MAX_CONSENTS = 200;
export const SUBJECT_EXPORT_MAX_ACTIVITIES = 1000;

const nullableText = z.string().nullable();

const submissionRowSchema = z.strictObject({
  id: z.guid(),
  created_at: z.date(),
  fields: z.record(z.string(), z.unknown()),
  message: nullableText,
  utm_source: nullableText,
  utm_medium: nullableText,
  utm_campaign: nullableText,
  utm_term: nullableText,
  utm_content: nullableText,
  utm_id: nullableText,
  gclid: nullableText,
  gbraid: nullableText,
  wbraid: nullableText,
  fbclid: nullableText,
  ttclid: nullableText,
  msclkid: nullableText,
  fbp: nullableText,
  fbc: nullableText,
  ga_client_id: nullableText,
  landing_page_url: nullableText,
  referrer_url: nullableText,
  consent_state: z.record(z.string(), z.unknown()),
  client_ip: nullableText,
  user_agent: nullableText,
});

const consentRowSchema = z.strictObject({
  purpose: z.string(),
  granted: z.boolean(),
  policy_version: z.string(),
  created_at: z.date(),
});

const activityRowSchema = z.strictObject({
  id: z.guid(),
  type: z.enum(LEAD_ACTIVITY_TYPES),
  actor_type: z.enum(['system', 'user', 'ai']),
  actor_id: z.guid().nullable(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.date(),
});

function toSubmission(raw: object): SubjectSubmission {
  const row = submissionRowSchema.parse(raw);
  return {
    id: row.id,
    createdAt: row.created_at,
    fields: row.fields,
    message: row.message,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmTerm: row.utm_term,
    utmContent: row.utm_content,
    utmId: row.utm_id,
    gclid: row.gclid,
    gbraid: row.gbraid,
    wbraid: row.wbraid,
    fbclid: row.fbclid,
    ttclid: row.ttclid,
    msclkid: row.msclkid,
    fbp: row.fbp,
    fbc: row.fbc,
    gaClientId: row.ga_client_id,
    landingPageUrl: row.landing_page_url,
    referrerUrl: row.referrer_url,
    consentState: row.consent_state,
    clientIp: row.client_ip,
    userAgent: row.user_agent,
  };
}

function toConsent(raw: object): SubjectConsent {
  const row = consentRowSchema.parse(raw);
  return {
    purpose: row.purpose,
    granted: row.granted,
    policyVersion: row.policy_version,
    recordedAt: row.created_at,
  };
}

function toActivity(raw: object): SubjectActivity {
  const row = activityRowSchema.parse(raw);
  return {
    id: row.id,
    type: row.type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: row.created_at,
    data: row.data,
  };
}

function capped<T>(rows: readonly T[], limit: number): { kept: readonly T[]; cut: boolean } {
  return rows.length > limit
    ? { kept: rows.slice(0, limit), cut: true }
    : { kept: rows, cut: false };
}

/**
 * Everything the system holds about one lead besides its row (LGPD right of access, G14): all
 * submissions (with IP and user agent while not purged), the full consent history and the whole
 * timeline including notes. Newest first, each array capped; `truncated` tells when a cap cut.
 */
export function createPostgresSubjectDataReader(): SubjectDataReader {
  return {
    async read(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
    ): Promise<SubjectDataBundle> {
      const sql = unwrapTransaction(tx);
      const submissions = await sql<object[]>`
        SELECT
          id, created_at, fields, message, utm_source, utm_medium, utm_campaign, utm_term,
          utm_content, utm_id, gclid, gbraid, wbraid, fbclid, ttclid, msclkid, fbp, fbc,
          ga_client_id, landing_page_url, referrer_url, consent_state,
          host(client_ip) AS client_ip, user_agent
        FROM capture.submissions
        WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId}
        ORDER BY created_at DESC, id ASC
        LIMIT ${SUBJECT_EXPORT_MAX_SUBMISSIONS + 1}
      `;
      const consents = await sql<object[]>`
        SELECT purpose, granted, policy_version, created_at
        FROM capture.consents
        WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId}
        ORDER BY created_at DESC, id ASC
        LIMIT ${SUBJECT_EXPORT_MAX_CONSENTS + 1}
      `;
      const activities = await sql<object[]>`
        SELECT id, type, actor_type, actor_id, data, created_at
        FROM crm.lead_activities
        WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId}
        ORDER BY created_at DESC, id ASC
        LIMIT ${SUBJECT_EXPORT_MAX_ACTIVITIES + 1}
      `;
      const cutSubmissions = capped(submissions, SUBJECT_EXPORT_MAX_SUBMISSIONS);
      const cutConsents = capped(consents, SUBJECT_EXPORT_MAX_CONSENTS);
      const cutActivities = capped(activities, SUBJECT_EXPORT_MAX_ACTIVITIES);
      return {
        submissions: cutSubmissions.kept.map(toSubmission),
        consents: cutConsents.kept.map(toConsent),
        activities: cutActivities.kept.map(toActivity),
        truncated: cutSubmissions.cut || cutConsents.cut || cutActivities.cut,
      };
    },
  };
}
