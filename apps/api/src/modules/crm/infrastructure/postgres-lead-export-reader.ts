import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  LeadExportFilter,
  LeadExportReader,
  LeadExportRow,
} from '#/modules/crm/application/commands/ports.ts';

const exportRowSchema = z.strictObject({
  id: z.guid(),
  created_at: z.date(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  whatsapp_e164: z.string(),
  company_name: z.string(),
  area_of_expertise: z.string(),
  area_of_expertise_other: z.string().nullable(),
  job_title: z.string().nullable(),
  company_size: z.string().nullable(),
  company_website: z.string().nullable(),
  stage: z.string(),
  lost_reason: z.string().nullable(),
  score: z.number().int(),
  score_band: z.string(),
  owner_user_id: z.guid().nullable(),
  marketing_opt_in: z.boolean(),
  submissions_count: z.number().int(),
  first_submitted_at: z.date(),
  last_submitted_at: z.date(),
  anonymized_at: z.date().nullable(),
  first_touch_utm_source: z.string().nullable(),
  first_touch_utm_medium: z.string().nullable(),
  first_touch_utm_campaign: z.string().nullable(),
  last_touch_utm_source: z.string().nullable(),
  last_touch_utm_medium: z.string().nullable(),
  last_touch_utm_campaign: z.string().nullable(),
});

function toExportRow(raw: object): LeadExportRow {
  const row = exportRowSchema.parse(raw);
  return {
    leadId: row.id,
    createdAt: row.created_at,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    whatsapp: row.whatsapp_e164,
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
    ownerUserId: row.owner_user_id,
    marketingOptIn: row.marketing_opt_in,
    submissionsCount: row.submissions_count,
    firstSubmittedAt: row.first_submitted_at,
    lastSubmittedAt: row.last_submitted_at,
    anonymizedAt: row.anonymized_at,
    firstTouchUtmSource: row.first_touch_utm_source,
    firstTouchUtmMedium: row.first_touch_utm_medium,
    firstTouchUtmCampaign: row.first_touch_utm_campaign,
    lastTouchUtmSource: row.last_touch_utm_source,
    lastTouchUtmMedium: row.last_touch_utm_medium,
    lastTouchUtmCampaign: row.last_touch_utm_campaign,
  };
}

/**
 * Export projection of `crm.leads`: only the columns of the contract's CSV — never IP, user agent,
 * message, click IDs, `fbp`/`fbc` or notes. Filters are bound parameters (conditional SQL fragments
 * of the driver, no string building); the order is the total order `created_at DESC, id ASC`.
 */
export function createPostgresLeadExportReader(): LeadExportReader {
  return {
    async read(
      tx: Transaction,
      workspaceId: WorkspaceId,
      filter: LeadExportFilter,
      limit: number,
    ): Promise<readonly LeadExportRow[]> {
      const sql = unwrapTransaction(tx);
      const stage = filter.stage === undefined ? sql`` : sql`AND stage = ${filter.stage}`;
      const scoreBand =
        filter.scoreBand === undefined ? sql`` : sql`AND score_band = ${filter.scoreBand}`;
      const owner =
        filter.owner === undefined
          ? sql``
          : filter.owner.kind === 'unassigned'
            ? sql`AND owner_user_id IS NULL`
            : sql`AND owner_user_id = ${filter.owner.userId}`;
      const rows = await sql<object[]>`
        SELECT
          id, created_at, first_name, last_name, email, whatsapp_e164, company_name,
          area_of_expertise, area_of_expertise_other, job_title, company_size, company_website,
          stage, lost_reason, score, score_band, owner_user_id, marketing_opt_in,
          submissions_count, first_submitted_at, last_submitted_at, anonymized_at,
          first_touch ->> 'utm_source' AS first_touch_utm_source,
          first_touch ->> 'utm_medium' AS first_touch_utm_medium,
          first_touch ->> 'utm_campaign' AS first_touch_utm_campaign,
          last_touch ->> 'utm_source' AS last_touch_utm_source,
          last_touch ->> 'utm_medium' AS last_touch_utm_medium,
          last_touch ->> 'utm_campaign' AS last_touch_utm_campaign
        FROM crm.leads
        WHERE workspace_id = ${workspaceId}
          ${stage}
          ${scoreBand}
          ${owner}
        ORDER BY created_at DESC, id ASC
        LIMIT ${limit}
      `;
      return rows.map(toExportRow);
    },
  };
}
