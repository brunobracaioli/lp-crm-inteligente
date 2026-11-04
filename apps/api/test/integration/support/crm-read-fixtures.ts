import type { Sql } from '#/platform/db/client.ts';
import type { IdGenerator, WorkspaceId } from '#/shared/ids.ts';
import type { WorkspaceFixture } from './fixtures.ts';

/**
 * Rows for the CRM read-model tests, inserted through the admin connection (RLS bypassed) so the
 * tests control every column the read side orders or filters by — notably `created_at` down to the
 * microsecond.
 */

const HEX_64 = 'a'.repeat(64);

export interface LeadSeed {
  readonly createdAt?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly companyName?: string;
  readonly stage?: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';
  readonly scoreBand?: 'A' | 'B' | 'C';
  readonly ownerUserId?: string | null;
}

export interface SeededLead {
  readonly id: string;
  readonly createdAt: string;
}

export const DEFAULT_CREATED_AT = '2026-11-03T14:00:00.000000Z';

export async function insertLead(
  admin: Sql,
  ids: IdGenerator,
  workspaceId: WorkspaceId,
  seed: LeadSeed = {},
): Promise<SeededLead> {
  const id = ids.uuidv7();
  const createdAt = seed.createdAt ?? DEFAULT_CREATED_AT;
  const stage = seed.stage ?? 'new';
  await admin`
    INSERT INTO crm.leads (
      id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name,
      area_of_expertise, stage, lost_reason, score, score_band, owner_user_id,
      first_submitted_at, last_submitted_at, created_at, updated_at
    ) VALUES (
      ${id}, ${workspaceId}, ${seed.firstName ?? 'Maria'}, ${seed.lastName ?? 'Silva'},
      ${seed.email ?? `lead-${id.slice(-12)}@empresa.com.br`}, '+5511912345678',
      ${seed.companyName ?? 'Empresa Ltda'}, 'technology', ${stage},
      ${stage === 'lost' ? 'timing' : null}, 50, ${seed.scoreBand ?? 'B'}, ${seed.ownerUserId ?? null},
      ${createdAt}::text::timestamptz, ${createdAt}::text::timestamptz, ${createdAt}::text::timestamptz,
      ${createdAt}::text::timestamptz
    )
  `;
  return { id, createdAt };
}

export interface SubmissionSeed {
  readonly createdAt?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly message?: string | null;
  readonly clientIp?: string | null;
  readonly userAgent?: string | null;
  readonly utmSource?: string | null;
  readonly gclid?: string | null;
  readonly fbclid?: string | null;
  readonly fbp?: string | null;
  readonly fbc?: string | null;
  readonly gaClientId?: string | null;
}

export async function insertSubmission(
  admin: Sql,
  ids: IdGenerator,
  fixture: WorkspaceFixture,
  leadId: string,
  seed: SubmissionSeed = {},
): Promise<string> {
  const id = ids.uuidv7();
  const consentState = {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  };
  await admin`
    INSERT INTO capture.submissions (
      id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, message,
      utm_source, gclid, fbclid, fbp, fbc, ga_client_id, landing_page_url, consent_state,
      client_ip, user_agent, ip_hmac, antibot, created_at
    ) VALUES (
      ${id}, ${fixture.workspaceId}, ${fixture.formId}, ${leadId}, ${ids.uuidv7()}, ${HEX_64},
      ${ids.uuidv7()}, ${admin.json((seed.fields ?? { first_name: 'Maria' }) as never)},
      ${seed.message ?? null}, ${seed.utmSource ?? null}, ${seed.gclid ?? null},
      ${seed.fbclid ?? null}, ${seed.fbp ?? null}, ${seed.fbc ?? null}, ${seed.gaClientId ?? null},
      'https://www.dominio.com.br/?utm_source=meta', ${admin.json(consentState)},
      ${seed.clientIp ?? null}::inet, ${seed.userAgent ?? null}, ${HEX_64}, ${admin.json({})},
      ${seed.createdAt ?? DEFAULT_CREATED_AT}::text::timestamptz
    )
  `;
  return id;
}

export async function insertConsent(
  admin: Sql,
  ids: IdGenerator,
  workspaceId: WorkspaceId,
  leadId: string,
  submissionId: string,
  seed: {
    readonly purpose: 'privacy_policy' | 'marketing_communications' | 'ad_tracking';
    readonly granted: boolean;
    readonly policyVersion?: string;
    readonly createdAt: string;
  },
): Promise<void> {
  await admin`
    INSERT INTO capture.consents (
      id, workspace_id, lead_id, submission_id, purpose, granted, policy_version, created_at
    ) VALUES (
      ${ids.uuidv7()}, ${workspaceId}, ${leadId}, ${submissionId}, ${seed.purpose}, ${seed.granted},
      ${seed.policyVersion ?? '2026-11-03'}, ${seed.createdAt}::text::timestamptz
    )
  `;
}

export async function insertActivity(
  admin: Sql,
  ids: IdGenerator,
  workspaceId: WorkspaceId,
  leadId: string,
  seed: {
    readonly type: string;
    readonly createdAt: string;
    readonly data?: Readonly<Record<string, unknown>>;
    readonly actorType?: 'system' | 'user' | 'ai';
    readonly actorId?: string | null;
  },
): Promise<string> {
  const id = ids.uuidv7();
  await admin`
    INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type, actor_id, data, created_at)
    VALUES (
      ${id}, ${workspaceId}, ${leadId}, ${seed.type}, ${seed.actorType ?? 'system'},
      ${seed.actorId ?? null}, ${admin.json((seed.data ?? {}) as never)}, ${seed.createdAt}::text::timestamptz
    )
  `;
  return id;
}

/** `created_at` shifted by whole microseconds from a base instant (microsecond-precision ISO text). */
export function microsecondsAfter(base: string, microseconds: number): string {
  const match = /^(.*\.)(\d{6})Z$/.exec(base);
  if (match === null) throw new Error('base must have microsecond precision');
  const baseMicros = Number(match[2]);
  const carrySeconds = Math.floor((baseMicros + microseconds) / 1_000_000);
  const micros = (((baseMicros + microseconds) % 1_000_000) + 1_000_000) % 1_000_000;
  const seconds = new Date(match[1]?.replace(/\.$/, 'Z') ?? '').getTime() + carrySeconds * 1000;
  return `${new Date(seconds).toISOString().replace(/\.\d{3}Z$/, '.')}${micros.toString().padStart(6, '0')}Z`;
}
