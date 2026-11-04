import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import { AREAS_OF_EXPERTISE, COMPANY_SIZES } from '#/shared/lead-profile.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import {
  CLICK_ID_TYPES,
  type ActivityListQuery,
  type ActivityView,
  type AttributionSummaryView,
  type ClickIdType,
  type ConsentStateView,
  type ConsentValue,
  type ConsentView,
  type KeysetPosition,
  type LeadListQuery,
  type LeadProfileRecord,
  type LeadQueries,
  type LeadSummaryView,
  type Page,
  type SubmissionFieldsView,
  type SubmissionView,
} from '#/modules/crm/application/queries/ports.ts';
import { LEAD_ACTIVITY_TYPES, LEAD_STAGES, LOST_REASONS } from '#/modules/crm/domain/lead-types.ts';
import { activityDataForContract } from '#/modules/crm/infrastructure/activity-data.ts';

/**
 * Read model of the staff UI (wave 9b). Everything runs on the transaction of the workspace-scoped
 * unit of work, and EVERY query also filters `workspace_id` explicitly — RLS is the second barrier.
 *
 * `capture.submissions` and `capture.consents` belong to the lead-capture context; they are read
 * here with plain SQL, read-only, on explicit columns (same pattern as ADR-0008). `client_ip`,
 * `user_agent`, `ip_hmac`, `fbp`, `fbc`, `ga_client_id`, click ID values, `antibot` and the
 * idempotency columns are never selected: click IDs only leave the database as a presence flag.
 */

/*
 * Keyset values are selected as `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
 * (`position_key`): the exact UTC instant with microseconds, because a JS Date would truncate to
 * milliseconds and the `created_at = $cursor` tie-break would stop matching. The position is bound as
 * `::text::timestamptz` on purpose: a parameter typed `timestamptz` is run through `new Date(...)` by
 * the driver, which would drop the microseconds again.
 */

const MAX_SCORE_CONTRIBUTIONS = 50;
const MAX_RULE_ID_LENGTH = 64;

const timestamp = z.date();
const nullableTimestamp = z.date().nullable();

const summaryRowSchema = z.strictObject({
  id: z.guid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  company_name: z.string(),
  job_title: z.string().nullable(),
  area_of_expertise: z.enum(AREAS_OF_EXPERTISE),
  company_size: z.enum(COMPANY_SIZES).nullable(),
  stage: z.enum(LEAD_STAGES),
  lost_reason: z.enum(LOST_REASONS).nullable(),
  score: z.number().int(),
  score_band: z.enum(['A', 'B', 'C']),
  owner_user_id: z.guid().nullable(),
  submissions_count: z.number().int(),
  first_submitted_at: timestamp,
  last_submitted_at: timestamp,
  created_at: timestamp,
  updated_at: timestamp,
  anonymized_at: nullableTimestamp,
  version: z.number().int(),
  position_key: z.string(),
});

const profileRowSchema = summaryRowSchema.omit({ position_key: true }).extend({
  whatsapp_e164: z.string(),
  area_of_expertise_other: z.string().nullable(),
  company_website: z.string().nullable(),
  marketing_opt_in: z.boolean(),
  score_breakdown: z
    .array(
      z.strictObject({
        rule_id: z.string().min(1).max(MAX_RULE_ID_LENGTH),
        points: z.number(),
      }),
    )
    .max(MAX_SCORE_CONTRIBUTIONS),
  first_touch: z.unknown(),
  last_touch: z.unknown(),
});

const submissionRowSchema = z.strictObject({
  id: z.guid(),
  created_at: timestamp,
  fields: z.unknown(),
  message: z.string().nullable(),
  consent_state: z.unknown(),
  utm_source: z.string().nullable(),
  utm_medium: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  utm_term: z.string().nullable(),
  utm_content: z.string().nullable(),
  utm_id: z.string().nullable(),
  landing_page_url: z.string().nullable(),
  referrer_url: z.string().nullable(),
  has_gclid: z.boolean(),
  has_gbraid: z.boolean(),
  has_wbraid: z.boolean(),
  has_fbclid: z.boolean(),
  has_ttclid: z.boolean(),
  has_msclkid: z.boolean(),
});

const consentRowSchema = z.strictObject({
  purpose: z.enum(['privacy_policy', 'marketing_communications', 'ad_tracking']),
  granted: z.boolean(),
  policy_version: z.string(),
  created_at: timestamp,
});

const activityRowSchema = z.strictObject({
  id: z.guid(),
  type: z.enum(LEAD_ACTIVITY_TYPES),
  actor_type: z.enum(['system', 'user', 'ai']),
  actor_id: z.guid().nullable(),
  data: z.unknown(),
  created_at: timestamp,
  position_key: z.string(),
});

type SummaryRow = z.infer<typeof summaryRowSchema>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function enumOf<T extends string>(source: unknown, key: string, allowed: readonly T[]): T | null {
  const value = textOf(source, key);
  return allowed.find((candidate) => candidate === value) ?? null;
}

function toSummary(row: SummaryRow | z.infer<typeof profileRowSchema>): LeadSummaryView {
  return {
    id: row.id as LeadId,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    companyName: row.company_name,
    jobTitle: row.job_title,
    areaOfExpertise: row.area_of_expertise,
    companySize: row.company_size,
    stage: row.stage,
    lostReason: row.lost_reason,
    score: row.score,
    scoreBand: row.score_band,
    ownerUserId: row.owner_user_id as UserId | null,
    submissionsCount: row.submissions_count,
    firstSubmittedAt: row.first_submitted_at,
    lastSubmittedAt: row.last_submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    anonymizedAt: row.anonymized_at,
    version: row.version,
  };
}

/** `first_touch` / `last_touch` jsonb → the contract's attribution summary (click IDs as types). */
function attributionFromJson(touch: unknown): AttributionSummaryView {
  return {
    utmSource: textOf(touch, 'utm_source'),
    utmMedium: textOf(touch, 'utm_medium'),
    utmCampaign: textOf(touch, 'utm_campaign'),
    utmTerm: textOf(touch, 'utm_term'),
    utmContent: textOf(touch, 'utm_content'),
    utmId: textOf(touch, 'utm_id'),
    landingPageUrl: textOf(touch, 'landing_page_url'),
    referrerUrl: textOf(touch, 'referrer_url'),
    clickIdTypes: CLICK_ID_TYPES.filter((type) => textOf(touch, type) !== null),
  };
}

function fieldsFromJson(fields: unknown): SubmissionFieldsView {
  return {
    firstName: textOf(fields, 'first_name'),
    lastName: textOf(fields, 'last_name'),
    email: textOf(fields, 'email'),
    whatsapp: textOf(fields, 'whatsapp'),
    company: textOf(fields, 'company'),
    areaOfExpertise: enumOf(fields, 'area_of_expertise', AREAS_OF_EXPERTISE),
    areaOfExpertiseOther: textOf(fields, 'area_of_expertise_other'),
    jobTitle: textOf(fields, 'job_title'),
    companySize: enumOf(fields, 'company_size', COMPANY_SIZES),
    companyWebsite: textOf(fields, 'company_website'),
    marketingOptIn:
      isRecord(fields) && typeof fields.marketing_opt_in === 'boolean'
        ? fields.marketing_opt_in
        : null,
  };
}

const CONSENT_VALUES: readonly ConsentValue[] = ['granted', 'denied'];

function consentStateFromJson(state: unknown): ConsentStateView {
  return {
    analyticsStorage: enumOf(state, 'analytics_storage', CONSENT_VALUES),
    adStorage: enumOf(state, 'ad_storage', CONSENT_VALUES),
    adUserData: enumOf(state, 'ad_user_data', CONSENT_VALUES),
    adPersonalization: enumOf(state, 'ad_personalization', CONSENT_VALUES),
  };
}

function toSubmission(row: z.infer<typeof submissionRowSchema>): SubmissionView {
  const present: Readonly<Record<ClickIdType, boolean>> = {
    gclid: row.has_gclid,
    gbraid: row.has_gbraid,
    wbraid: row.has_wbraid,
    fbclid: row.has_fbclid,
    ttclid: row.has_ttclid,
    msclkid: row.has_msclkid,
  };
  return {
    id: row.id,
    createdAt: row.created_at,
    fields: fieldsFromJson(row.fields),
    message: row.message,
    attribution: {
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      utmCampaign: row.utm_campaign,
      utmTerm: row.utm_term,
      utmContent: row.utm_content,
      utmId: row.utm_id,
      landingPageUrl: row.landing_page_url,
      referrerUrl: row.referrer_url,
      clickIdTypes: CLICK_ID_TYPES.filter((type) => present[type]),
    },
    consentState: consentStateFromJson(row.consent_state),
  };
}

function toActivity(row: z.infer<typeof activityRowSchema>): ActivityView {
  return {
    id: row.id,
    type: row.type,
    actorType: row.actor_type,
    actorId: row.actor_id as UserId | null,
    createdAt: row.created_at,
    data: activityDataForContract(row.type, row.data),
  };
}

/**
 * Escapes `\`, `%` and `_` so a user-typed term is matched literally by `LIKE … ESCAPE '\'`.
 * (The term is always bound as a parameter; this only neutralizes LIKE's own wildcards.)
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/** Rows fetched is `limit + 1`: the extra row only proves another page exists. */
function toPage<Row extends { readonly id: string; readonly position_key: string }, View>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => View,
): Page<View> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const next: KeysetPosition | null =
    rows.length > limit && last !== undefined
      ? { createdAt: last.position_key, id: last.id }
      : null;
  return { items: pageRows.map(map), next };
}

export function createPostgresLeadQueries(): LeadQueries {
  return {
    async listLeads(tx: Transaction, query: LeadListQuery): Promise<Page<LeadSummaryView>> {
      const sql = unwrapTransaction(tx);
      const { filters, after } = query;

      const stage = filters.stage === null ? sql`` : sql`AND l.stage = ${filters.stage}`;
      const band =
        filters.scoreBand === null ? sql`` : sql`AND l.score_band = ${filters.scoreBand}`;
      let owner = sql``;
      if (filters.owner?.kind === 'unassigned') {
        owner = sql`AND l.owner_user_id IS NULL`;
      } else if (filters.owner?.kind === 'user') {
        owner = sql`AND l.owner_user_id = ${filters.owner.userId}`;
      }
      const pattern = filters.prefix === null ? null : `${escapeLikePattern(filters.prefix)}%`;
      const search =
        pattern === null
          ? sql``
          : sql`AND (
              lower(l.first_name) LIKE lower(${pattern}) ESCAPE '\\'
              OR lower(l.last_name) LIKE lower(${pattern}) ESCAPE '\\'
              OR lower(l.first_name || ' ' || l.last_name) LIKE lower(${pattern}) ESCAPE '\\'
              OR lower(l.company_name) LIKE lower(${pattern}) ESCAPE '\\'
              OR lower(l.email) LIKE lower(${pattern}) ESCAPE '\\'
            )`;
      // Keyset of ORDER BY created_at DESC, id ASC: strictly older, or the same instant and a larger id.
      const keyset =
        after === null
          ? sql``
          : sql`AND (
              l.created_at < ${after.createdAt}::text::timestamptz
              OR (l.created_at = ${after.createdAt}::text::timestamptz AND l.id > ${after.id}::uuid)
            )`;

      const rows = await sql<object[]>`
        SELECT
          l.id, l.first_name, l.last_name, l.email, l.company_name, l.job_title,
          l.area_of_expertise, l.company_size, l.stage, l.lost_reason, l.score, l.score_band,
          l.owner_user_id, l.submissions_count, l.first_submitted_at, l.last_submitted_at,
          l.created_at, l.updated_at, l.anonymized_at, l.version,
          to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position_key
        FROM crm.leads l
        WHERE l.workspace_id = ${query.workspaceId}
          ${stage} ${owner} ${band} ${search} ${keyset}
        ORDER BY l.created_at DESC, l.id ASC
        LIMIT ${query.limit + 1}
      `;
      return toPage(
        rows.map((row) => summaryRowSchema.parse(row)),
        query.limit,
        toSummary,
      );
    },

    async findLeadProfile(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
    ): Promise<LeadProfileRecord | null> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT
          l.id, l.first_name, l.last_name, l.email, l.company_name, l.job_title,
          l.area_of_expertise, l.company_size, l.stage, l.lost_reason, l.score, l.score_band,
          l.owner_user_id, l.submissions_count, l.first_submitted_at, l.last_submitted_at,
          l.created_at, l.updated_at, l.anonymized_at, l.version,
          l.whatsapp_e164, l.area_of_expertise_other, l.company_website, l.marketing_opt_in,
          l.score_breakdown, l.first_touch, l.last_touch
        FROM crm.leads l
        WHERE l.workspace_id = ${workspaceId} AND l.id = ${leadId}
      `;
      const raw = rows[0];
      if (raw === undefined) return null;
      const row = profileRowSchema.parse(raw);
      return {
        profile: {
          ...toSummary(row),
          whatsappE164: row.whatsapp_e164,
          areaOfExpertiseOther: row.area_of_expertise_other,
          companyWebsite: row.company_website,
          marketingOptIn: row.marketing_opt_in,
          scoreBreakdown: row.score_breakdown.map((item) => ({
            ruleId: item.rule_id,
            points: item.points,
          })),
        },
        firstTouch: attributionFromJson(row.first_touch),
        lastTouch: attributionFromJson(row.last_touch),
      };
    },

    async listSubmissions(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
      limit: number,
    ): Promise<readonly SubmissionView[]> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT
          s.id, s.created_at, s.fields, s.message, s.consent_state,
          s.utm_source, s.utm_medium, s.utm_campaign, s.utm_term, s.utm_content, s.utm_id,
          s.landing_page_url, s.referrer_url,
          coalesce(s.gclid, '') <> '' AS has_gclid,
          coalesce(s.gbraid, '') <> '' AS has_gbraid,
          coalesce(s.wbraid, '') <> '' AS has_wbraid,
          coalesce(s.fbclid, '') <> '' AS has_fbclid,
          coalesce(s.ttclid, '') <> '' AS has_ttclid,
          coalesce(s.msclkid, '') <> '' AS has_msclkid
        FROM capture.submissions s
        WHERE s.workspace_id = ${workspaceId} AND s.lead_id = ${leadId}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ${limit}
      `;
      return rows.map((row) => toSubmission(submissionRowSchema.parse(row)));
    },

    async currentConsents(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
    ): Promise<readonly ConsentView[]> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT DISTINCT ON (c.purpose) c.purpose, c.granted, c.policy_version, c.created_at
        FROM capture.consents c
        WHERE c.workspace_id = ${workspaceId} AND c.lead_id = ${leadId}
        ORDER BY c.purpose, c.created_at DESC, c.id DESC
      `;
      return rows.map((raw) => {
        const row = consentRowSchema.parse(raw);
        return {
          purpose: row.purpose,
          granted: row.granted,
          policyVersion: row.policy_version,
          recordedAt: row.created_at,
        };
      });
    },

    async listActivities(tx: Transaction, query: ActivityListQuery): Promise<Page<ActivityView>> {
      const sql = unwrapTransaction(tx);
      const { after } = query;
      // Keyset of ORDER BY created_at DESC, id DESC.
      const keyset =
        after === null
          ? sql``
          : sql`AND (
              a.created_at < ${after.createdAt}::text::timestamptz
              OR (a.created_at = ${after.createdAt}::text::timestamptz AND a.id < ${after.id}::uuid)
            )`;
      const rows = await sql<object[]>`
        SELECT
          a.id, a.type, a.actor_type, a.actor_id, a.data, a.created_at,
          to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position_key
        FROM crm.lead_activities a
        WHERE a.workspace_id = ${query.workspaceId} AND a.lead_id = ${query.leadId}
          ${keyset}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${query.limit + 1}
      `;
      return toPage(
        rows.map((row) => activityRowSchema.parse(row)),
        query.limit,
        toActivity,
      );
    },
  };
}
