import { randomUUID } from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import type { OutboxStatus } from '#/modules/tracking/application/ports.ts';
import type { LeadId, OutboxEventId, SubmissionId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction, UnitOfWork } from '#/shared/unit-of-work.ts';

/**
 * Integration harness for the tracking adapters. Two connections, like production vs. migrations:
 *
 * - `TEST_DATABASE_URL`: the runtime role `lp_api` (RLS applies, no BYPASSRLS). Everything under
 *   test runs through it.
 * - `TEST_DATABASE_ADMIN_URL`: the migration owner, used ONLY to seed fixtures and to read state
 *   back. Defaults to the local `supabase start` Postgres.
 *
 * The suite is skipped when `TEST_DATABASE_URL` is unset so `pnpm test:integration` stays usable
 * without a database.
 */
export const RUNTIME_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const POOL_SIZE = 5;

export function connectRuntime(): Sql {
  if (RUNTIME_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is not set');
  return postgres(RUNTIME_DATABASE_URL, { max: POOL_SIZE, onnotice: () => undefined });
}

export function connectAdmin(): Sql {
  return postgres(ADMIN_DATABASE_URL, { max: 2, onnotice: () => undefined });
}

/**
 * Minimal Postgres unit of work with the semantics of the production one (ADR-0003): one
 * transaction per `run`, `app.workspace_id` set transaction-locally for RLS. The production
 * implementation is owned by the composition root; this one only exists to drive the adapters.
 */
export class TestPostgresUnitOfWork implements UnitOfWork {
  readonly #sql: Sql;
  readonly #handles = new WeakMap<object, TransactionSql>();

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /** `TransactionSqlResolver` for the adapters. */
  readonly resolve = (tx: Transaction): TransactionSql => {
    const handle = this.#handles.get(tx);
    if (handle === undefined) throw new Error('transaction handle is not open');
    return handle;
  };

  async run<T>(workspaceId: WorkspaceId, work: (tx: Transaction) => Promise<T>): Promise<T> {
    const result: unknown = await this.#sql.begin(async (transaction) => {
      await transaction`SELECT pg_catalog.set_config('app.workspace_id', ${workspaceId}, true)`;
      const token = Object.freeze({}) as unknown as Transaction;
      this.#handles.set(token, transaction);
      return work(token);
    });
    return result as T;
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
  const consent = JSON.stringify(options.consent ?? GRANTED_CONSENT);
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
      'https://lp.example.test/oferta?utm_source=meta', ${consent}::jsonb,
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
      ${JSON.stringify({ lead_id: submission.leadId, submission_id: submission.submissionId })}::jsonb,
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
