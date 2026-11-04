import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresLeadConversionSourceReader } from '#/modules/tracking/infrastructure/postgres-lead-conversion-source-reader.ts';
import type { LeadCapturedPayload } from '#/modules/tracking/public-api.ts';
import {
  RUNTIME_DATABASE_URL,
  TestPostgresUnitOfWork,
  connectAdmin,
  connectRuntime,
  deleteWorkspace,
  seedSubmission,
  seedWorkspace,
  type SeedSubmissionOptions,
  type SeededSubmission,
  type SeededWorkspace,
} from './tracking-db.ts';

function payloadOf(submission: SeededSubmission): LeadCapturedPayload {
  return { lead_id: submission.leadId, submission_id: submission.submissionId };
}

describe.skipIf(RUNTIME_DATABASE_URL === undefined)('PostgresLeadConversionSourceReader', () => {
  let admin: Sql;
  let runtime: Sql;
  let uow: TestPostgresUnitOfWork;
  let reader: PostgresLeadConversionSourceReader;
  const workspaces: SeededWorkspace[] = [];

  async function seed(options: SeedSubmissionOptions = {}) {
    const workspace = await seedWorkspace(admin);
    workspaces.push(workspace);
    return { workspace, submission: await seedSubmission(admin, workspace, options) };
  }

  beforeAll(() => {
    admin = connectAdmin();
    runtime = connectRuntime();
    uow = new TestPostgresUnitOfWork(runtime);
    reader = new PostgresLeadConversionSourceReader(uow.resolve);
  });

  afterAll(async () => {
    for (const workspace of workspaces) {
      await deleteWorkspace(admin, workspace.workspaceId);
    }
    await runtime.end();
    await admin.end();
  });

  it('loads the identity, attribution, consent and code-only custom data of the submission', async () => {
    const { workspace, submission } = await seed({ companySize: '11_50' });

    const source = await uow.run(workspace.workspaceId, (tx) =>
      reader.load(tx, workspace.workspaceId, payloadOf(submission)),
    );

    expect(source).toMatchObject({
      leadId: submission.leadId,
      eventId: submission.eventId,
      firstName: 'Maria',
      lastName: 'Souza',
      whatsappE164: '+5511987654321',
      clientIp: '203.0.113.7',
      userAgent: 'TestAgent/1.0',
      fbp: 'fb.1.1730635200000.1116446470',
      fbc: null,
      fbclid: 'IwAR0TestClickId',
      landingPageUrl: 'https://lp.example.test/oferta?utm_source=meta',
      consent: {
        analyticsStorage: 'granted',
        adStorage: 'granted',
        adUserData: 'granted',
        adPersonalization: 'granted',
      },
      customData: {
        lead_source: 'meta',
        area_of_expertise: 'technology',
        company_size: '11_50',
        score_band: 'A',
      },
    });
    expect(source?.email).toMatch(/^maria\..+@example\.com$/u);
    expect(source?.submissionCreatedAt).toBeInstanceOf(Date);
  });

  it('falls back to lead_source "direct" and omits company_size when unknown', async () => {
    const { workspace, submission } = await seed({ utmSource: null, companySize: null });

    const source = await uow.run(workspace.workspaceId, (tx) =>
      reader.load(tx, workspace.workspaceId, payloadOf(submission)),
    );

    expect(source?.customData).toEqual({
      lead_source: 'direct',
      area_of_expertise: 'technology',
      score_band: 'A',
    });
  });

  it('reads the denied consent exactly as stored (so the policy can skip the destination)', async () => {
    const { workspace, submission } = await seed({
      consent: {
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      },
    });

    const source = await uow.run(workspace.workspaceId, (tx) =>
      reader.load(tx, workspace.workspaceId, payloadOf(submission)),
    );

    expect(source?.consent).toEqual({
      analyticsStorage: 'granted',
      adStorage: 'denied',
      adUserData: 'denied',
      adPersonalization: 'denied',
    });
  });

  it('returns null IP and user agent after the 30-day purge', async () => {
    const { workspace, submission } = await seed({ purgedPii: true });

    const source = await uow.run(workspace.workspaceId, (tx) =>
      reader.load(tx, workspace.workspaceId, payloadOf(submission)),
    );

    expect(source).toMatchObject({ clientIp: null, userAgent: null });
  });

  it('returns null for an anonymized lead (nothing may be sent for an erased identity)', async () => {
    const { workspace, submission } = await seed({ anonymized: true });

    const source = await uow.run(workspace.workspaceId, (tx) =>
      reader.load(tx, workspace.workspaceId, payloadOf(submission)),
    );

    expect(source).toBeNull();
  });

  it('returns null when the submission does not belong to the lead of the payload', async () => {
    const { workspace, submission } = await seed();
    const other = await seedSubmission(admin, workspace);

    const source = await uow.run(workspace.workspaceId, (tx) =>
      reader.load(tx, workspace.workspaceId, {
        lead_id: other.leadId,
        submission_id: submission.submissionId,
      }),
    );

    expect(source).toBeNull();
  });

  it('cross-tenant: another workspace gets null, never the lead data', async () => {
    const owner = await seed();
    const intruder = await seed();

    const viaIntruderScope = await uow.run(intruder.workspace.workspaceId, (tx) =>
      reader.load(tx, intruder.workspace.workspaceId, payloadOf(owner.submission)),
    );
    const claimingOwnerWorkspace = await uow.run(intruder.workspace.workspaceId, (tx) =>
      reader.load(tx, owner.workspace.workspaceId, payloadOf(owner.submission)),
    );

    expect(viaIntruderScope).toBeNull();
    expect(claimingOwnerWorkspace).toBeNull();
  });
});
