import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { createPostgresUnitOfWork, unwrapTransaction } from '#/platform/db/index.ts';
import { openTestDatabase } from '#test/integration/support/database.ts';
import type { OutboxStatus } from '#/modules/tracking/application/ports.ts';
import type { LeadId, OutboxEventId, SubmissionId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction, UnitOfWork } from '#/shared/unit-of-work.ts';

/**
 * Integration harness for the tracking adapters, on the shared local-database support of Onda 4
 * (`support/database.ts`: `TEST_DATABASE_URL` as `lp_api` under RLS, `TEST_ADMIN_DATABASE_URL` as
 * the migration owner for fixtures only, loopback hosts only, `lp_api` password synced locally).
 */
export async function connectTrackingDatabases(): Promise<{ admin: Sql; runtime: Sql }> {
  const { admin, app } = await openTestDatabase({ maxConnections: POOL_SIZE });
  return { admin, runtime: app };
}

const POOL_SIZE = 5;

/**
 * The production `PostgresUnitOfWork` plus the `TransactionSqlResolver` the tracking adapters take
 * (`unwrapTransaction`), so the suite exercises exactly what the composition root wires.
 */
export class TestPostgresUnitOfWork implements UnitOfWork {
  readonly #inner: UnitOfWork;

  constructor(sql: Sql) {
    this.#inner = createPostgresUnitOfWork(sql);
  }

  readonly resolve = (tx: Transaction): TransactionSql => unwrapTransaction(tx);

  run<T>(workspaceId: WorkspaceId, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#inner.run(workspaceId, work);
  }
}

export interface SeededWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly formId: string;
}

export interface SeededSubmission {
  readonly leadId: LeadId;
  readonly submissionId: SubmissionId;
  readonly eventId: string;
}

export interface SeedSubmissionOptions {
  readonly consent?: Readonly<Record<string, 'granted' | 'denied'>>;
  readonly utmSource?: string | null;
  readonly companySize?: string | null;
  readonly anonymized?: boolean;
  readonly purgedPii?: boolean;
}

const GRANTED_CONSENT = {
  analytics_storage: 'granted',
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
} as const;

const SHORT_ID_LENGTH = 12;

function shortId(): string {
  return randomUUID().replaceAll('-', '').slice(0, SHORT_ID_LENGTH);
}

export async function seedWorkspace(admin: Sql): Promise<SeededWorkspace> {
  const workspaceId = randomUUID() as WorkspaceId;
  const formId = randomUUID();
  await admin`
    INSERT INTO core.workspaces (id, slug, name)
    VALUES (${workspaceId}, ${`t-${shortId()}`}, 'Tracking integration')
  `;
  await admin`
    INSERT INTO core.forms (id, workspace_id, form_key, name, allowed_origins, privacy_policy_version)
    VALUES (${formId}, ${workspaceId}, ${`frm_${shortId()}`}, 'Tracking form',
            ARRAY['https://lp.example.test'], '2026-11-03')
  `;
  return { workspaceId, formId };
}

export async function seedSubmission(
  admin: Sql,
  workspace: SeededWorkspace,
  options: SeedSubmissionOptions = {},
): Promise<SeededSubmission> {
  const leadId = randomUUID() as LeadId;
  const submissionId = randomUUID() as SubmissionId;
  const eventId = randomUUID();
  const consent = admin.json({ ...(options.consent ?? GRANTED_CONSENT) });
  await admin`
    INSERT INTO crm.leads (
      id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise,
      company_size, score, score_band, first_submitted_at, last_submitted_at, anonymized_at)
    VALUES (
      ${leadId}, ${workspace.workspaceId}, 'Maria', 'Souza', ${`maria.${shortId()}@example.com`},
      '+5511987654321', 'Empresa Teste', 'technology', ${options.companySize ?? null}, 80, 'A',
      now(), now(), ${options.anonymized === true ? new Date() : null})
  `;
  await admin`
    INSERT INTO capture.submissions (
      id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields,
      utm_source, fbp, fbc, fbclid, landing_page_url, consent_state, client_ip, user_agent,
      ip_hmac, antibot, pii_purged_at)
    VALUES (
      ${submissionId}, ${workspace.workspaceId}, ${workspace.formId}, ${leadId}, ${randomUUID()},
      ${'a'.repeat(64)}, ${eventId}, '{}'::jsonb, ${options.utmSource === undefined ? 'meta' : options.utmSource},
      'fb.1.1730635200000.1116446470', NULL, 'IwAR0TestClickId',
      'https://lp.example.test/oferta?utm_source=meta', ${consent},
      ${options.purgedPii === true ? null : '203.0.113.7'},
      ${options.purgedPii === true ? null : 'TestAgent/1.0'},
      ${'b'.repeat(64)}, '{"provider":"turnstile","challenge_age_s":4}'::jsonb,
      ${options.purgedPii === true ? new Date() : null})
  `;
  return { leadId, submissionId, eventId };
}

export interface SeedOutboxOptions {
  readonly status?: OutboxStatus;
  readonly attempts?: number;
  readonly createdAt?: Date;
  readonly nextAttemptAt?: Date;
  readonly lockedUntil?: Date | null;
}

export async function seedOutboxEvent(
  admin: Sql,
  workspace: SeededWorkspace,
  submission: SeededSubmission,
  options: SeedOutboxOptions = {},
): Promise<OutboxEventId> {
  const id = randomUUID() as OutboxEventId;
  const createdAt = options.createdAt ?? new Date();
  await admin`
    INSERT INTO tracking.outbox_events (
      id, workspace_id, aggregate_type, aggregate_id, event_type, payload, status, attempts,
      next_attempt_at, locked_until, created_at)
    VALUES (
      ${id}, ${workspace.workspaceId}, 'lead', ${submission.leadId}, 'lead.captured',
      ${admin.json({ lead_id: submission.leadId, submission_id: submission.submissionId })},
      ${options.status ?? 'pending'}, ${options.attempts ?? 0},
      ${options.nextAttemptAt ?? createdAt}, ${options.lockedUntil ?? null}, ${createdAt})
  `;
  return id;
}

export interface OutboxState {
  readonly status: string;
  readonly attempts: number;
  readonly locked_until: Date | null;
  readonly next_attempt_at: Date;
  readonly processed_at: Date | null;
}

export async function readOutboxState(admin: Sql, id: OutboxEventId): Promise<OutboxState> {
  const [row] = await admin<OutboxState[]>`
    SELECT status, attempts, locked_until, next_attempt_at, processed_at
    FROM tracking.outbox_events WHERE id = ${id}
  `;
  if (row === undefined) throw new Error('outbox row not found');
  return row;
}

export interface DeliveryState {
  readonly destination: string;
  readonly status: string;
  readonly attempts: number;
  readonly last_http_status: number | null;
  readonly last_error_code: string | null;
  readonly external_ref: string | null;
}

export function readDeliveries(admin: Sql, id: OutboxEventId): Promise<DeliveryState[]> {
  return admin<DeliveryState[]>`
    SELECT destination, status, attempts, last_http_status, last_error_code, external_ref
    FROM tracking.deliveries WHERE outbox_event_id = ${id} ORDER BY destination ASC
  `;
}

/** Removes everything a test workspace created (the migration owner bypasses RLS). */
export async function deleteWorkspace(admin: Sql, workspaceId: WorkspaceId): Promise<void> {
  await admin`DELETE FROM tracking.deliveries WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM tracking.outbox_events WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM capture.submissions WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM crm.leads WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM core.forms WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM core.workspaces WHERE id = ${workspaceId}`;
}
