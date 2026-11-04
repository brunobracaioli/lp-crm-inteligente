import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import {
  AREAS_OF_EXPERTISE,
  COMPANY_SIZES,
  type AttributionSnapshot,
} from '#/shared/lead-profile.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type { LeadRepository, LeadState } from '#/modules/crm/application/ports.ts';
import { LEAD_STAGES, LOST_REASONS } from '#/modules/crm/domain/lead-types.ts';

/** Upper bound of score contributions kept per lead (the score v1 has fewer than a dozen rules). */
const MAX_SCORE_CONTRIBUTIONS = 50;
const MAX_RULE_ID_LENGTH = 64;

const nullableText = z.string().nullish();

/** jsonb shape of `first_touch` / `last_touch`: snake_case keys, absent when the value is unknown. */
const attributionJsonSchema = z.strictObject({
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
});

/** jsonb shape of `score_breakdown` (database §3.3): `[{rule_id, points}]`. */
const scoreBreakdownJsonSchema = z
  .array(
    z.strictObject({
      rule_id: z.string().min(1).max(MAX_RULE_ID_LENGTH),
      points: z.number(),
    }),
  )
  .max(MAX_SCORE_CONTRIBUTIONS);

/** Every column of `crm.leads` the aggregate persists; `.strict()` fails loudly on a schema drift. */
const leadRowSchema = z.strictObject({
  id: z.guid(),
  workspace_id: z.guid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  whatsapp_e164: z.string(),
  company_name: z.string(),
  area_of_expertise: z.enum(AREAS_OF_EXPERTISE),
  area_of_expertise_other: z.string().nullable(),
  job_title: z.string().nullable(),
  company_size: z.enum(COMPANY_SIZES).nullable(),
  company_website: z.string().nullable(),
  stage: z.enum(LEAD_STAGES),
  lost_reason: z.enum(LOST_REASONS).nullable(),
  score: z.number().int(),
  score_band: z.enum(['A', 'B', 'C']),
  score_breakdown: scoreBreakdownJsonSchema,
  owner_user_id: z.guid().nullable(),
  marketing_opt_in: z.boolean(),
  submissions_count: z.number().int(),
  first_touch: attributionJsonSchema,
  last_touch: attributionJsonSchema,
  first_submitted_at: z.date(),
  last_submitted_at: z.date(),
  anonymized_at: z.date().nullable(),
  version: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});

type AttributionJson = z.infer<typeof attributionJsonSchema>;

function attributionFromJson(json: AttributionJson): AttributionSnapshot {
  return {
    utmSource: json.utm_source ?? null,
    utmMedium: json.utm_medium ?? null,
    utmCampaign: json.utm_campaign ?? null,
    utmTerm: json.utm_term ?? null,
    utmContent: json.utm_content ?? null,
    utmId: json.utm_id ?? null,
    gclid: json.gclid ?? null,
    gbraid: json.gbraid ?? null,
    wbraid: json.wbraid ?? null,
    fbclid: json.fbclid ?? null,
    ttclid: json.ttclid ?? null,
    msclkid: json.msclkid ?? null,
    fbp: json.fbp ?? null,
    fbc: json.fbc ?? null,
    gaClientId: json.ga_client_id ?? null,
    landingPageUrl: json.landing_page_url ?? null,
    referrerUrl: json.referrer_url ?? null,
  };
}

/** Unknown values are omitted, so an empty touch is `{}` (the column default). */
function attributionToJson(attribution: AttributionSnapshot): Record<string, string> {
  const entries: readonly (readonly [string, string | null])[] = [
    ['utm_source', attribution.utmSource],
    ['utm_medium', attribution.utmMedium],
    ['utm_campaign', attribution.utmCampaign],
    ['utm_term', attribution.utmTerm],
    ['utm_content', attribution.utmContent],
    ['utm_id', attribution.utmId],
    ['gclid', attribution.gclid],
    ['gbraid', attribution.gbraid],
    ['wbraid', attribution.wbraid],
    ['fbclid', attribution.fbclid],
    ['ttclid', attribution.ttclid],
    ['msclkid', attribution.msclkid],
    ['fbp', attribution.fbp],
    ['fbc', attribution.fbc],
    ['ga_client_id', attribution.gaClientId],
    ['landing_page_url', attribution.landingPageUrl],
    ['referrer_url', attribution.referrerUrl],
  ];
  const json: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value !== null) {
      json[key] = value;
    }
  }
  return json;
}

function toLeadState(row: z.infer<typeof leadRowSchema>): LeadState {
  return {
    id: row.id as LeadId,
    workspaceId: row.workspace_id as WorkspaceId,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    whatsappE164: row.whatsapp_e164,
    companyName: row.company_name,
    areaOfExpertise: row.area_of_expertise,
    areaOfExpertiseOther: row.area_of_expertise_other,
    jobTitle: row.job_title,
    companySize: row.company_size,
    companyWebsite: row.company_website,
    stage: row.stage,
    lostReason: row.lost_reason,
    score: row.score,
    scoreBand: row.score_band,
    scoreBreakdown: row.score_breakdown.map((item) => ({
      ruleId: item.rule_id,
      points: item.points,
    })),
    ownerUserId: row.owner_user_id as UserId | null,
    marketingOptIn: row.marketing_opt_in,
    submissionsCount: row.submissions_count,
    firstTouch: attributionFromJson(row.first_touch),
    lastTouch: attributionFromJson(row.last_touch),
    firstSubmittedAt: row.first_submitted_at,
    lastSubmittedAt: row.last_submitted_at,
    anonymizedAt: row.anonymized_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a raw `crm.leads` row (every persisted column) to the aggregate state. Exposed so the
 * read-by-id adapter of the staff commands shares the one parsing definition of the table.
 */
export function leadStateFromRow(row: object): LeadState {
  return toLeadState(leadRowSchema.parse(row));
}

/**
 * `crm.leads` (Lead aggregate). Race safety comes from the partial unique index
 * `(workspace_id, email) WHERE anonymized_at IS NULL`; concurrency on one lead from the row lock
 * (`FOR UPDATE`) plus the optimistic `version` check.
 */
export function createPostgresLeadRepository(): LeadRepository {
  return {
    async insertIfAbsent(tx: Transaction, lead: LeadState): Promise<'inserted' | 'exists'> {
      const sql = unwrapTransaction(tx);
      const inserted = await sql<object[]>`
        INSERT INTO crm.leads (
          id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name,
          area_of_expertise, area_of_expertise_other, job_title, company_size, company_website,
          stage, lost_reason, score, score_band, score_breakdown, owner_user_id, marketing_opt_in,
          submissions_count, first_touch, last_touch, first_submitted_at, last_submitted_at,
          anonymized_at, version, created_at, updated_at
        ) VALUES (
          ${lead.id}, ${lead.workspaceId}, ${lead.firstName}, ${lead.lastName}, ${lead.email},
          ${lead.whatsappE164}, ${lead.companyName}, ${lead.areaOfExpertise},
          ${lead.areaOfExpertiseOther}, ${lead.jobTitle}, ${lead.companySize}, ${lead.companyWebsite},
          ${lead.stage}, ${lead.lostReason}, ${lead.score}, ${lead.scoreBand},
          ${sql.json(lead.scoreBreakdown.map((item) => ({ rule_id: item.ruleId, points: item.points })))},
          ${lead.ownerUserId}, ${lead.marketingOptIn}, ${lead.submissionsCount},
          ${sql.json(attributionToJson(lead.firstTouch))}, ${sql.json(attributionToJson(lead.lastTouch))},
          ${lead.firstSubmittedAt}, ${lead.lastSubmittedAt}, ${lead.anonymizedAt}, ${lead.version},
          ${lead.createdAt}, ${lead.updatedAt}
        )
        ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL DO NOTHING
        RETURNING id
      `;
      return inserted.length > 0 ? 'inserted' : 'exists';
    },

    async findActiveByEmailForUpdate(
      tx: Transaction,
      workspaceId: WorkspaceId,
      email: string,
    ): Promise<LeadState | null> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT
          id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name,
          area_of_expertise, area_of_expertise_other, job_title, company_size, company_website,
          stage, lost_reason, score, score_band, score_breakdown, owner_user_id, marketing_opt_in,
          submissions_count, first_touch, last_touch, first_submitted_at, last_submitted_at,
          anonymized_at, version, created_at, updated_at
        FROM crm.leads
        WHERE workspace_id = ${workspaceId} AND email = ${email} AND anonymized_at IS NULL
        FOR UPDATE
      `;
      const row = rows[0];
      return row === undefined ? null : toLeadState(leadRowSchema.parse(row));
    },

    async update(
      tx: Transaction,
      lead: LeadState,
      expectedVersion: number,
    ): Promise<'updated' | 'version_conflict'> {
      const sql = unwrapTransaction(tx);
      const updated = await sql<object[]>`
        UPDATE crm.leads SET
          first_name = ${lead.firstName},
          last_name = ${lead.lastName},
          email = ${lead.email},
          whatsapp_e164 = ${lead.whatsappE164},
          company_name = ${lead.companyName},
          area_of_expertise = ${lead.areaOfExpertise},
          area_of_expertise_other = ${lead.areaOfExpertiseOther},
          job_title = ${lead.jobTitle},
          company_size = ${lead.companySize},
          company_website = ${lead.companyWebsite},
          stage = ${lead.stage},
          lost_reason = ${lead.lostReason},
          score = ${lead.score},
          score_band = ${lead.scoreBand},
          score_breakdown = ${sql.json(lead.scoreBreakdown.map((item) => ({ rule_id: item.ruleId, points: item.points })))},
          owner_user_id = ${lead.ownerUserId},
          marketing_opt_in = ${lead.marketingOptIn},
          submissions_count = ${lead.submissionsCount},
          first_touch = ${sql.json(attributionToJson(lead.firstTouch))},
          last_touch = ${sql.json(attributionToJson(lead.lastTouch))},
          first_submitted_at = ${lead.firstSubmittedAt},
          last_submitted_at = ${lead.lastSubmittedAt},
          anonymized_at = ${lead.anonymizedAt},
          version = ${expectedVersion + 1}
        WHERE workspace_id = ${lead.workspaceId} AND id = ${lead.id} AND version = ${expectedVersion}
        RETURNING id
      `;
      return updated.length > 0 ? 'updated' : 'version_conflict';
    },
  };
}
