import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresAuditLogWriter } from '#/platform/db/postgres-audit-log-writer.ts';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import type {
  CorrelationId,
  EventId,
  IdempotencyKey,
  LeadId,
  OutboxEventId,
  SubmissionId,
} from '#/shared/ids.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import type { ConsentRecord, SubmissionRecord } from '#/modules/lead-capture/application/ports.ts';
import { createPostgresConsentRepository } from '#/modules/lead-capture/infrastructure/postgres-consent-repository.ts';
import { createPostgresFormLookup } from '#/modules/lead-capture/infrastructure/postgres-form-lookup.ts';
import { createPostgresSubmissionRepository } from '#/modules/lead-capture/infrastructure/postgres-submission-repository.ts';
import { createPostgresOutboxWriter } from '#/modules/tracking/infrastructure/postgres-outbox-writer.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import {
  FIXTURE_ORIGIN,
  FIXTURE_POLICY_VERSION,
  FixtureScope,
  aLeadState,
  type WorkspaceFixture,
} from './support/fixtures.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

const ids = new RandomUuidV7Generator();
const leads = createPostgresLeadRepository();
const submissions = createPostgresSubmissionRepository();
const consents = createPostgresConsentRepository();
const outbox = createPostgresOutboxWriter();
const audit = createPostgresAuditLogWriter();
const NOW = new Date('2026-11-03T12:00:00.000Z');

let db: TestDatabase;
let scope: FixtureScope;
let uow: UnitOfWork;

beforeAll(async () => {
  db = await openTestDatabase();
  uow = createPostgresUnitOfWork(db.app);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  scope = new FixtureScope(db.admin, ids);
});

afterEach(async () => {
  await scope.dispose();
});

/** Persists a lead and returns what submissions and consents must point at. */
async function aStoredLead(fixture: WorkspaceFixture): Promise<LeadId> {
  const lead = aLeadState(fixture.workspaceId, ids);
  await uow.run(fixture.workspaceId, (tx) => leads.insertIfAbsent(tx, lead));
  return lead.id;
}

function aSubmission(
  fixture: WorkspaceFixture,
  leadId: LeadId,
  overrides: Partial<SubmissionRecord> = {},
): SubmissionRecord {
  return {
    id: ids.uuidv7() as SubmissionId,
    workspaceId: fixture.workspaceId,
    formId: fixture.formId,
    leadId,
    idempotencyKey: ids.uuidv7() as IdempotencyKey,
    requestHash: 'a'.repeat(64),
    eventId: ids.uuidv7() as EventId,
    fields: { first_name: 'Maria', marketing_opt_in: true, job_title: null },
    message: 'Olá,\nquero conhecer o CRM',
    attribution: {
      utmSource: 'meta',
      utmMedium: 'cpc',
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      utmId: null,
      gclid: null,
      gbraid: null,
      wbraid: null,
      fbclid: 'IwAR123',
      ttclid: null,
      msclkid: null,
      fbp: 'fb.1.1730600000000.123456789',
      fbc: null,
      gaClientId: '123.456',
      landingPageUrl: `${FIXTURE_ORIGIN}/?utm_source=meta`,
      referrerUrl: null,
    },
    consentState: {
      analyticsStorage: 'granted',
      adStorage: 'denied',
      adUserData: 'granted',
      adPersonalization: 'denied',
    },
    clientIp: '203.0.113.7',
    userAgent: 'Mozilla/5.0 TestBrowser/1.0',
    ipHmac: 'b'.repeat(64),
    antibot: { provider: 'turnstile', challengeAgeSeconds: 4, ephemeralId: null },
    createdAt: NOW,
    ...overrides,
  };
}

describe('PostgresFormLookup', () => {
  it('finds an active form by its public key', async () => {
    const fixture = await scope.workspace();

    const form = await createPostgresFormLookup(db.app).findActiveByKey(fixture.formKey);

    expect(form).toEqual({
      id: fixture.formId,
      workspaceId: fixture.workspaceId,
      formKey: fixture.formKey,
      allowedOrigins: [FIXTURE_ORIGIN],
      turnstileAction: 'lead_submit',
      privacyPolicyVersion: FIXTURE_POLICY_VERSION,
    });
  });

  it.each(['paused', 'archived'] as const)('hides a %s form', async (formStatus) => {
    const fixture = await scope.workspace({ formStatus });

    expect(await createPostgresFormLookup(db.app).findActiveByKey(fixture.formKey)).toBeNull();
  });

  it('returns null for an unknown key, including injection-shaped input', async () => {
    const lookup = createPostgresFormLookup(db.app);

    expect(await lookup.findActiveByKey('frm_does_not_exist')).toBeNull();
    expect(await lookup.findActiveByKey("frm_x' OR '1'='1")).toBeNull();
  });
});

describe('PostgresSubmissionRepository', () => {
  it('inserts a submission and reads it back by idempotency key', async () => {
    const fixture = await scope.workspace();
    const leadId = await aStoredLead(fixture);
    const submission = aSubmission(fixture, leadId);

    const outcome = await uow.run(fixture.workspaceId, (tx) => submissions.insert(tx, submission));
    const reference = await uow.run(fixture.workspaceId, (tx) =>
      submissions.findByIdempotencyKey(tx, fixture.workspaceId, submission.idempotencyKey),
    );
    const stored = await db.admin<
      {
        fields: unknown;
        consent_state: unknown;
        antibot: unknown;
        client_ip: string;
        utm_source: string;
        fbp: string;
        created_at: Date;
      }[]
    >`
      SELECT fields, consent_state, antibot, client_ip, utm_source, fbp, created_at
      FROM capture.submissions WHERE id = ${submission.id}
    `;

    expect(outcome).toBe('inserted');
    expect(reference).toEqual({
      submissionId: submission.id,
      eventId: submission.eventId,
      requestHash: submission.requestHash,
    });
    expect(stored[0]).toEqual({
      fields: submission.fields,
      consent_state: {
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'granted',
        ad_personalization: 'denied',
      },
      antibot: { provider: 'turnstile', challenge_age_seconds: 4, ephemeral_id: null },
      client_ip: '203.0.113.7',
      utm_source: 'meta',
      fbp: 'fb.1.1730600000000.123456789',
      created_at: NOW,
    });
  });

  it('findByIdempotencyKey returns null for an unknown key', async () => {
    const fixture = await scope.workspace();

    const reference = await uow.run(fixture.workspaceId, (tx) =>
      submissions.findByIdempotencyKey(tx, fixture.workspaceId, ids.uuidv7() as IdempotencyKey),
    );

    expect(reference).toBeNull();
  });

  it('reports duplicate_idempotency_key without aborting the transaction', async () => {
    const fixture = await scope.workspace();
    const leadId = await aStoredLead(fixture);
    const original = aSubmission(fixture, leadId);
    await uow.run(fixture.workspaceId, (tx) => submissions.insert(tx, original));

    // Same key, even with a fresh event id: the key decides. The transaction stays usable afterwards.
    const result = await uow.run(fixture.workspaceId, async (tx) => ({
      outcome: await submissions.insert(
        tx,
        aSubmission(fixture, leadId, { idempotencyKey: original.idempotencyKey }),
      ),
      stored: await submissions.findByIdempotencyKey(
        tx,
        fixture.workspaceId,
        original.idempotencyKey,
      ),
    }));

    expect(result.outcome).toBe('duplicate_idempotency_key');
    expect(result.stored?.submissionId).toBe(original.id);
  });

  it('reports duplicate_event_id when only the Pixel event id collides', async () => {
    const fixture = await scope.workspace();
    const leadId = await aStoredLead(fixture);
    const original = aSubmission(fixture, leadId);
    await uow.run(fixture.workspaceId, (tx) => submissions.insert(tx, original));

    const outcome = await uow.run(fixture.workspaceId, (tx) =>
      submissions.insert(tx, aSubmission(fixture, leadId, { eventId: original.eventId })),
    );
    const count = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM capture.submissions WHERE workspace_id = ${fixture.workspaceId}
    `;

    expect(outcome).toBe('duplicate_event_id');
    expect(count[0]?.n).toBe(1);
  });

  it('allows the same idempotency key and event id in different workspaces', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const leadOfA = await aStoredLead(a);
    const leadOfB = await aStoredLead(b);
    const original = aSubmission(a, leadOfA);

    const outcomes = [
      await uow.run(a.workspaceId, (tx) => submissions.insert(tx, original)),
      await uow.run(b.workspaceId, (tx) =>
        submissions.insert(
          tx,
          aSubmission(b, leadOfB, {
            idempotencyKey: original.idempotencyKey,
            eventId: original.eventId,
          }),
        ),
      ),
    ];

    expect(outcomes).toEqual(['inserted', 'inserted']);
  });

  it('refuses a submission that references a lead of another workspace', async () => {
    const a = await scope.workspace();
    const b = await scope.workspace();
    const leadOfB = await aStoredLead(b);

    await expect(
      uow.run(a.workspaceId, (tx) => submissions.insert(tx, aSubmission(a, leadOfB))),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('PostgresConsentRepository', () => {
  it('appends the consents of a submission in one statement', async () => {
    const fixture = await scope.workspace();
    const leadId = await aStoredLead(fixture);
    const submission = aSubmission(fixture, leadId);
    const record = (purpose: ConsentRecord['purpose'], granted: boolean): ConsentRecord => ({
      id: ids.uuidv7(),
      workspaceId: fixture.workspaceId,
      leadId,
      submissionId: submission.id,
      purpose,
      granted,
      policyVersion: FIXTURE_POLICY_VERSION,
      createdAt: NOW,
    });

    await uow.run(fixture.workspaceId, async (tx) => {
      await submissions.insert(tx, submission);
      await consents.appendMany(tx, [
        record('privacy_policy', true),
        record('marketing_communications', false),
        record('ad_tracking', true),
      ]);
      await consents.appendMany(tx, []);
    });

    const rows = await db.admin<{ purpose: string; granted: boolean; policy_version: string }[]>`
      SELECT purpose, granted, policy_version
      FROM capture.consents WHERE submission_id = ${submission.id} ORDER BY purpose
    `;
    expect(rows).toEqual([
      { purpose: 'ad_tracking', granted: true, policy_version: FIXTURE_POLICY_VERSION },
      {
        purpose: 'marketing_communications',
        granted: false,
        policy_version: FIXTURE_POLICY_VERSION,
      },
      { purpose: 'privacy_policy', granted: true, policy_version: FIXTURE_POLICY_VERSION },
    ]);
  });
});

describe('PostgresOutboxWriter', () => {
  it('enqueues a pending lead.captured event with an ID-only payload', async () => {
    const fixture = await scope.workspace();
    const leadId = await aStoredLead(fixture);
    const submissionId = ids.uuidv7() as SubmissionId;
    const eventId = ids.uuidv7() as OutboxEventId;

    await uow.run(fixture.workspaceId, (tx) =>
      outbox.enqueue(tx, {
        id: eventId,
        workspaceId: fixture.workspaceId,
        aggregateType: 'lead',
        aggregateId: leadId,
        eventType: 'lead.captured',
        payload: { lead_id: leadId, submission_id: submissionId },
        createdAt: NOW,
      }),
    );

    const rows = await db.admin<
      {
        aggregate_id: string;
        event_type: string;
        payload: unknown;
        status: string;
        attempts: number;
        created_at: Date;
      }[]
    >`
      SELECT aggregate_id, event_type, payload, status, attempts, created_at
      FROM tracking.outbox_events WHERE id = ${eventId}
    `;
    expect(rows).toEqual([
      {
        aggregate_id: leadId,
        event_type: 'lead.captured',
        payload: { lead_id: leadId, submission_id: submissionId },
        status: 'pending',
        attempts: 0,
        created_at: NOW,
      },
    ]);
  });
});

describe('PostgresAuditLogWriter', () => {
  it('appends an audit entry with its correlation id and metadata', async () => {
    const fixture = await scope.workspace();
    const resourceId = ids.uuidv7();
    const correlationId = ids.uuidv7() as CorrelationId;

    await uow.run(fixture.workspaceId, (tx) =>
      audit.append(tx, {
        workspaceId: fixture.workspaceId,
        occurredAt: NOW,
        actorType: 'system',
        actorId: null,
        action: 'lead.captured',
        resourceType: 'submission',
        resourceId,
        result: 'success',
        correlationId,
        metadata: { lead_created: true, attempts: 1, note: null, form_id: fixture.formId },
      }),
    );

    const rows = await db.admin<
      {
        action: string;
        resource_id: string;
        result: string;
        correlation_id: string;
        metadata: unknown;
        occurred_at: Date;
      }[]
    >`
      SELECT action, resource_id, result, correlation_id, metadata, occurred_at
      FROM core.audit_log WHERE workspace_id = ${fixture.workspaceId}
    `;
    expect(rows).toEqual([
      {
        action: 'lead.captured',
        resource_id: resourceId,
        result: 'success',
        correlation_id: correlationId,
        metadata: { lead_created: true, attempts: 1, note: null, form_id: fixture.formId },
        occurred_at: NOW,
      },
    ]);
  });
});
