import type { Sql } from '#/platform/db/client.ts';
import type { FormId, IdGenerator, LeadId, WorkspaceId } from '#/shared/ids.ts';

const MS_PER_DAY = 86_400_000;
const GRANTED_CONSENT = {
  analytics_storage: 'granted',
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
};

/** A timestamp `days` before now; retention tests place rows on either side of a cutoff with it. */
export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

export interface SubmissionFixtureOptions {
  readonly workspaceId: WorkspaceId;
  readonly formId: FormId;
  readonly leadId: LeadId;
  readonly createdAt?: Date;
  readonly clientIp?: string | null;
  readonly userAgent?: string | null;
  readonly message?: string | null;
  readonly fields?: Readonly<Record<string, string>>;
  readonly landingPageUrl?: string | null;
}

/** Inserts a submission through the admin connection (RLS bypassed) and returns its id. */
export async function insertSubmission(
  admin: Sql,
  ids: IdGenerator,
  options: SubmissionFixtureOptions,
): Promise<string> {
  const id = ids.uuidv7();
  await admin`
    INSERT INTO capture.submissions (
      id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, message,
      utm_source, gclid, fbclid, fbp, fbc, ga_client_id, landing_page_url, referrer_url,
      consent_state, client_ip, user_agent, ip_hmac, antibot, created_at
    ) VALUES (
      ${id}, ${options.workspaceId}, ${options.formId}, ${options.leadId}, ${ids.uuidv7()},
      ${'a'.repeat(64)}, ${ids.uuidv7()}, ${admin.json({ ...(options.fields ?? {}) })},
      ${options.message ?? null}, 'meta', 'gclid-value', 'fbclid-value', 'fbp-value', 'fbc-value',
      'ga-client-value', ${options.landingPageUrl ?? null}, 'https://referrer.example/path?q=secret',
      ${admin.json(GRANTED_CONSENT)}, ${options.clientIp ?? null}::inet, ${options.userAgent ?? null},
      ${'b'.repeat(64)}, ${admin.json({ provider: 'turnstile', ephemeral_id: 'eph-123' })},
      ${options.createdAt ?? new Date()}
    )
  `;
  return id;
}

export async function insertConsent(
  admin: Sql,
  ids: IdGenerator,
  workspaceId: WorkspaceId,
  leadId: LeadId,
  submissionId: string,
): Promise<string> {
  const id = ids.uuidv7();
  await admin`
    INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version)
    VALUES (${id}, ${workspaceId}, ${leadId}, ${submissionId}, 'privacy_policy', true, '2026-11-03')
  `;
  return id;
}

export async function insertActivity(
  admin: Sql,
  ids: IdGenerator,
  options: {
    readonly workspaceId: WorkspaceId;
    readonly leadId: LeadId;
    readonly type: string;
    readonly data: Readonly<Record<string, string | number | boolean | null>>;
    readonly createdAt?: Date;
  },
): Promise<string> {
  const id = ids.uuidv7();
  await admin`
    INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type, actor_id, data, created_at)
    VALUES (
      ${id}, ${options.workspaceId}, ${options.leadId}, ${options.type}, 'user', ${ids.uuidv7()},
      ${admin.json({ ...options.data })}, ${options.createdAt ?? new Date()}
    )
  `;
  return id;
}

export async function insertOutboxEvent(
  admin: Sql,
  ids: IdGenerator,
  options: {
    readonly workspaceId: WorkspaceId;
    readonly leadId: LeadId;
    readonly status: 'pending' | 'processing' | 'done' | 'dead';
    readonly processedAt: Date | null;
    readonly deliveryStatuses?: readonly string[];
  },
): Promise<string> {
  const id = ids.uuidv7();
  await admin`
    INSERT INTO tracking.outbox_events (
      id, workspace_id, aggregate_type, aggregate_id, event_type, payload, status, processed_at, created_at
    ) VALUES (
      ${id}, ${options.workspaceId}, 'lead', ${options.leadId}, 'lead.captured', '{}'::jsonb,
      ${options.status}, ${options.processedAt}, ${options.processedAt ?? new Date()}
    )
  `;
  const destinations = ['meta_capi', 'ga4_mp', 'google_ads', 'ai_qualification'];
  for (const [index, status] of (options.deliveryStatuses ?? []).entries()) {
    await admin`
      INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination, status)
      VALUES (${ids.uuidv7()}, ${id}, ${options.workspaceId}, ${destinations[index] ?? 'meta_capi'}, ${status})
    `;
  }
  return id;
}

export async function insertAuditEntry(
  admin: Sql,
  ids: IdGenerator,
  workspaceId: WorkspaceId,
  occurredAt: Date,
): Promise<number> {
  const rows = await admin<{ id: string }[]>`
    INSERT INTO core.audit_log (workspace_id, occurred_at, actor_type, action, resource_type, result, correlation_id)
    VALUES (${workspaceId}, ${occurredAt}, 'system', 'lead.created', 'lead', 'success', ${ids.uuidv7()})
    RETURNING id::text AS id
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error('audit insert returned no row');
  }
  return Number(row.id);
}
