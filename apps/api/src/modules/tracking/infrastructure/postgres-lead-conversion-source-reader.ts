import { z } from 'zod';
import type {
  LeadConversionSource,
  LeadConversionSourceReader,
} from '#/modules/tracking/application/ports.ts';
import type { TransactionSqlResolver } from '#/modules/tracking/infrastructure/transaction-sql.ts';
import type { LeadCapturedPayload } from '#/modules/tracking/public-api.ts';
import type { ConsentState } from '#/shared/consent.ts';
import type { EventId, LeadId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

/** Fallback `lead_source` when the submission carried no `utm_source` (tracking §3). */
const DIRECT_LEAD_SOURCE = 'direct';

const DENIED_CONSENT: ConsentState = {
  analyticsStorage: 'denied',
  adStorage: 'denied',
  adUserData: 'denied',
  adPersonalization: 'denied',
};

const consentValue = z.enum(['granted', 'denied']);
const consentStateSchema = z.object({
  analytics_storage: consentValue,
  ad_storage: consentValue,
  ad_user_data: consentValue,
  ad_personalization: consentValue,
});

interface SourceRow {
  readonly lead_id: string;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly whatsapp_e164: string;
  readonly area_of_expertise: string;
  readonly company_size: string | null;
  readonly score_band: string;
  readonly event_id: string;
  readonly submission_created_at: Date;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly fbclid: string | null;
  readonly landing_page_url: string | null;
  readonly utm_source: string | null;
  readonly consent_state: unknown;
}

/** Consent that cannot be read is consent that was not given: fail closed. */
function parseConsent(value: unknown): ConsentState {
  const parsed = consentStateSchema.safeParse(value);
  if (!parsed.success) return DENIED_CONSENT;
  return {
    analyticsStorage: parsed.data.analytics_storage,
    adStorage: parsed.data.ad_storage,
    adUserData: parsed.data.ad_user_data,
    adPersonalization: parsed.data.ad_personalization,
  };
}

function customDataOf(row: SourceRow): Readonly<Record<string, string>> {
  const data: Record<string, string> = {
    lead_source: row.utm_source ?? DIRECT_LEAD_SOURCE,
    area_of_expertise: row.area_of_expertise,
    score_band: row.score_band,
  };
  if (row.company_size !== null) {
    data.company_size = row.company_size;
  }
  return data;
}

function toSource(row: SourceRow): LeadConversionSource {
  return {
    leadId: row.lead_id as LeadId,
    eventId: row.event_id as EventId,
    submissionCreatedAt: row.submission_created_at,
    email: row.email,
    whatsappE164: row.whatsapp_e164,
    firstName: row.first_name,
    lastName: row.last_name,
    clientIp: row.client_ip,
    userAgent: row.user_agent,
    fbp: row.fbp,
    fbc: row.fbc,
    fbclid: row.fbclid,
    landingPageUrl: row.landing_page_url,
    consent: parseConsent(row.consent_state),
    customData: customDataOf(row),
  };
}

/**
 * Loads the facts of a `Lead` conversion with ONE read-only, parameterized join over
 * `capture.submissions` and `crm.leads` (explicit columns, both filtered by workspace on top of RLS).
 *
 * Boundary decision (ADR-0001/0007 note, see the wave 5b report): tracking reads another context's
 * tables here instead of calling `crm/public-api.ts`, because the data it needs is split between
 * `crm` (identity, score) and `lead-capture` (consent, click ids, IP/UA) and neither public API
 * exposes it — nor should it: a use case returning raw PII for ad platforms is a larger surface
 * than a single audited SELECT in the tracking adapter. The query is the ONLY cross-context read;
 * it never writes, and the migration owns the columns it names. An ADR amendment should bless it.
 *
 * Anonymized leads yield `null` (the identity was erased; nothing may be sent for them).
 */
export class PostgresLeadConversionSourceReader implements LeadConversionSourceReader {
  readonly #sqlOf: TransactionSqlResolver;

  constructor(sqlOf: TransactionSqlResolver) {
    this.#sqlOf = sqlOf;
  }

  async load(
    tx: Transaction,
    workspaceId: WorkspaceId,
    payload: LeadCapturedPayload,
  ): Promise<LeadConversionSource | null> {
    const rows = await this.#sqlOf(tx)<SourceRow[]>`
      SELECT l.id AS lead_id, l.email, l.first_name, l.last_name, l.whatsapp_e164,
             l.area_of_expertise, l.company_size, l.score_band,
             s.event_id, s.created_at AS submission_created_at,
             pg_catalog.host(s.client_ip) AS client_ip, s.user_agent,
             s.fbp, s.fbc, s.fbclid, s.landing_page_url, s.utm_source, s.consent_state
      FROM capture.submissions AS s
      JOIN crm.leads AS l ON l.workspace_id = s.workspace_id AND l.id = s.lead_id
      WHERE s.id = ${payload.submission_id}
        AND s.lead_id = ${payload.lead_id}
        AND s.workspace_id = ${workspaceId}
        AND l.anonymized_at IS NULL
      LIMIT 1
    `;
    const [row] = rows;
    return row === undefined ? null : toSource(row);
  }
}
