import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { LeadId, WorkspaceId } from '#/shared/ids.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import { FixtureScope, aLeadState, type WorkspaceFixture } from './support/fixtures.ts';
import { insertActivity, insertConsent, insertSubmission } from './support/retention.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

// Mirrors supabase/tests/008_anonymize_lead.test.sql (pgTAP cannot run on the Docker-less local database).
const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';
const ANON_WHATSAPP = '+10000000000';
const ZERO_HASH = '0'.repeat(64);

// Original personal data: unique strings so the sweep can prove none of it survives.
const ORIGINAL = {
  firstName: 'Zuleica',
  lastName: 'Quaresma',
  whatsapp: '+5511987654321',
  company: 'Acme Quimica Ltda',
  website: 'https://acme-quimica.example',
  jobTitle: 'Diretora Comercial',
  message: 'Please call me about the Quaresma contract',
  noteBody: 'Zuleica said her husband owns the company',
  field: 'Zuleica Quaresma',
  referrerSecret: 'q=secret',
  freeTextKey: 'Zuleica private comment',
} as const;

const ids = new RandomUuidV7Generator();
const leads = createPostgresLeadRepository();

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

interface Seeded {
  readonly fixture: WorkspaceFixture;
  readonly leadId: LeadId;
  readonly email: string;
  readonly submissionId: string;
}

/** A lead with PII in every place the erasure must reach: lead, submission, notes, payloads, consent. */
async function seedFullLead(
  options: { readonly area?: 'technology' | 'other'; readonly stage?: 'new' | 'lost' } = {},
): Promise<Seeded> {
  const fixture = await scope.workspace();
  const touch = {
    ...aLeadState(fixture.workspaceId, ids).firstTouch,
    utmSource: 'meta',
    fbclid: 'IwAR-original',
    fbp: 'fb.1.original',
    gaClientId: 'GA1.original',
    landingPageUrl: 'https://www.dominio.com.br/lp?utm_source=meta&email=zuleica@acme.example',
    referrerUrl: 'https://referrer.example/path?q=secret',
  };
  const lead = aLeadState(fixture.workspaceId, ids, {
    firstName: ORIGINAL.firstName,
    lastName: ORIGINAL.lastName,
    whatsappE164: ORIGINAL.whatsapp,
    companyName: ORIGINAL.company,
    companyWebsite: ORIGINAL.website,
    jobTitle: ORIGINAL.jobTitle,
    email: `zuleica.${ids.uuidv7().slice(-8)}@acme.example`,
    areaOfExpertise: options.area ?? 'technology',
    areaOfExpertiseOther: options.area === 'other' ? 'Gestao de frotas refrigeradas' : null,
    stage: options.stage ?? 'new',
    lostReason: options.stage === 'lost' ? 'no_budget' : null,
    score: 61,
    scoreBand: 'B',
    marketingOptIn: true,
    firstTouch: touch,
    lastTouch: touch,
  });
  await uow.run(fixture.workspaceId, (tx) => leads.insertIfAbsent(tx, lead));
  const submissionId = await insertSubmission(db.admin, ids, {
    ...fixture,
    leadId: lead.id,
    clientIp: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (original)',
    message: ORIGINAL.message,
    fields: { name: ORIGINAL.field },
    landingPageUrl: touch.landingPageUrl,
  });
  await insertConsent(db.admin, ids, fixture.workspaceId, lead.id, submissionId);
  const base = { workspaceId: fixture.workspaceId, leadId: lead.id };
  await insertActivity(db.admin, ids, {
    ...base,
    type: 'submission_received',
    data: {
      submission_id: submissionId,
      score: 61,
      score_band: 'B',
      comment: ORIGINAL.freeTextKey,
    },
  });
  await insertActivity(db.admin, ids, {
    ...base,
    type: 'note_added',
    data: { body: ORIGINAL.noteBody },
  });
  await insertActivity(db.admin, ids, {
    ...base,
    type: 'stage_changed',
    data: { from: 'new', to: 'contacted', lost_reason: null },
  });
  return { fixture, leadId: lead.id, email: lead.email, submissionId };
}

/** Calls the public function the way the API will: inside a workspace-scoped transaction as `lp_api`. */
async function anonymize(
  workspaceId: WorkspaceId,
  leadId: string,
  actorType = 'user',
  actorId: string | null = ids.uuidv7(),
): Promise<boolean> {
  return uow.run(workspaceId, async (tx) => {
    const rows = await unwrapTransaction(tx)<{ anonymized: boolean }[]>`
      SELECT crm.anonymize_lead(${leadId}, ${actorType}, ${actorId}, ${ids.uuidv7()}) AS anonymized
    `;
    return rows[0]?.anonymized ?? false;
  });
}

describe('crm.anonymize_lead', () => {
  it('returns true and replaces every identifying lead column by a placeholder that satisfies the CHECKs', async () => {
    const { fixture, leadId } = await seedFullLead();

    const result = await anonymize(fixture.workspaceId, leadId);
    const [row] = await db.admin<Record<string, unknown>[]>`
      SELECT first_name, last_name, email, whatsapp_e164, company_name, company_website, job_title,
             area_of_expertise, area_of_expertise_other, marketing_opt_in, stage, score, score_band,
             version, anonymized_at, first_submitted_at, submissions_count
      FROM crm.leads WHERE id = ${leadId}
    `;

    expect(result).toBe(true);
    expect(row).toMatchObject({
      first_name: 'Anonymized',
      last_name: 'Lead',
      email: `anon+${leadId}@anonymized.invalid`,
      whatsapp_e164: ANON_WHATSAPP,
      company_name: 'Anonymized',
      company_website: null,
      job_title: null,
      area_of_expertise: 'technology',
      area_of_expertise_other: null,
      marketing_opt_in: false,
      // IDs, stage, score and dates survive for metrics.
      stage: 'new',
      score: 61,
      score_band: 'B',
      version: 2,
      submissions_count: 1,
    });
    expect(row?.anonymized_at).toBeInstanceOf(Date);
  });

  it('keeps the CHECK-consistent shape for an "other" area and a lost lead', async () => {
    const { fixture, leadId } = await seedFullLead({ area: 'other', stage: 'lost' });

    const result = await anonymize(fixture.workspaceId, leadId);
    const [row] = await db.admin<Record<string, unknown>[]>`
      SELECT area_of_expertise, area_of_expertise_other, stage, lost_reason
      FROM crm.leads WHERE id = ${leadId}
    `;

    expect(result).toBe(true);
    expect(row).toEqual({
      area_of_expertise: 'other',
      area_of_expertise_other: 'anonymized',
      stage: 'lost',
      lost_reason: 'no_budget',
    });
  });

  it('clears attribution identifiers but keeps campaign metadata', async () => {
    const { fixture, leadId } = await seedFullLead();

    await anonymize(fixture.workspaceId, leadId);
    const [row] = await db.admin<{ first_touch: unknown; last_touch: unknown }[]>`
      SELECT first_touch, last_touch FROM crm.leads WHERE id = ${leadId}
    `;

    const expected = {
      utm_source: 'meta',
      landing_page_url: 'https://www.dominio.com.br/lp',
      referrer_url: 'https://referrer.example/path',
    };
    expect(row?.first_touch).toEqual(expected);
    expect(row?.last_touch).toEqual(expected);
  });

  it('scrubs the submissions, keeps consents, and zeroes request/IP hashes', async () => {
    const { fixture, leadId, submissionId } = await seedFullLead();

    await anonymize(fixture.workspaceId, leadId);
    const [submission] = await db.admin<Record<string, unknown>[]>`
      SELECT fields, message, utm_source, gclid, fbclid, fbp, fbc, ga_client_id, landing_page_url,
             referrer_url, client_ip, user_agent, pii_purged_at, ip_hmac, request_hash, antibot
      FROM capture.submissions WHERE id = ${submissionId}
    `;
    const consents = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM capture.consents WHERE lead_id = ${leadId}
    `;

    expect(submission).toMatchObject({
      fields: {},
      message: null,
      utm_source: 'meta',
      gclid: null,
      fbclid: null,
      fbp: null,
      fbc: null,
      ga_client_id: null,
      landing_page_url: 'https://www.dominio.com.br/lp',
      referrer_url: 'https://referrer.example/path',
      client_ip: null,
      user_agent: null,
      ip_hmac: ZERO_HASH,
      request_hash: ZERO_HASH,
      antibot: { provider: 'turnstile' },
    });
    expect(submission?.pii_purged_at).toBeInstanceOf(Date);
    expect(consents[0]?.n).toBe(1);
  });

  it('scrubs note bodies and non-allow-listed payload keys, then appends one anonymized activity', async () => {
    const { fixture, leadId, submissionId } = await seedFullLead();
    const actorId = ids.uuidv7();

    await anonymize(fixture.workspaceId, leadId, 'user', actorId);
    const activities = await db.admin<
      { type: string; actor_type: string; actor_id: string | null; data: unknown }[]
    >`
      SELECT type, actor_type, actor_id, data FROM crm.lead_activities
      WHERE lead_id = ${leadId} ORDER BY created_at, type
    `;
    const byType = new Map(activities.map((row) => [row.type, row]));

    expect(activities).toHaveLength(4);
    expect(byType.get('note_added')?.data).toEqual({ body: '[anonymized]' });
    expect(byType.get('submission_received')?.data).toEqual({
      submission_id: submissionId,
      score: 61,
      score_band: 'B',
    });
    expect(byType.get('stage_changed')?.data).toEqual({
      from: 'new',
      to: 'contacted',
      lost_reason: null,
    });
    expect(byType.get('anonymized')).toEqual({
      type: 'anonymized',
      actor_type: 'user',
      actor_id: actorId,
      data: {},
    });
  });

  it('leaves no trace of the original personal data anywhere in the workspace', async () => {
    const { fixture, leadId, email } = await seedFullLead();
    await anonymize(fixture.workspaceId, leadId);

    const dump = await db.admin<{ blob: string }[]>`
      SELECT row_to_json(t)::text AS blob FROM crm.leads t WHERE workspace_id = ${fixture.workspaceId}
      UNION ALL SELECT row_to_json(t)::text FROM capture.submissions t WHERE workspace_id = ${fixture.workspaceId}
      UNION ALL SELECT row_to_json(t)::text FROM capture.consents t WHERE workspace_id = ${fixture.workspaceId}
      UNION ALL SELECT row_to_json(t)::text FROM crm.lead_activities t WHERE workspace_id = ${fixture.workspaceId}
      UNION ALL SELECT row_to_json(t)::text FROM tracking.outbox_events t WHERE workspace_id = ${fixture.workspaceId}
      UNION ALL SELECT row_to_json(t)::text FROM core.audit_log t WHERE workspace_id = ${fixture.workspaceId}
    `;
    const haystack = dump.map((row) => row.blob).join('\n');

    const originals = [
      email,
      email.split('@')[0] ?? email,
      ...Object.values(ORIGINAL),
      '203.0.113.7',
      'Mozilla/5.0 (original)',
      'IwAR-original',
      'fb.1.original',
      'GA1.original',
      'gclid-value',
      'Gestao de frotas',
    ];
    for (const original of originals) {
      expect(haystack, original).not.toContain(original);
    }
  });

  it('is idempotent: the second call returns false and changes nothing', async () => {
    const { fixture, leadId } = await seedFullLead();

    const first = await anonymize(fixture.workspaceId, leadId);
    const [after] = await db.admin<{ version: number; anonymized_at: Date }[]>`
      SELECT version, anonymized_at FROM crm.leads WHERE id = ${leadId}
    `;
    const second = await anonymize(fixture.workspaceId, leadId);
    const [again] = await db.admin<{ version: number; anonymized_at: Date }[]>`
      SELECT version, anonymized_at FROM crm.leads WHERE id = ${leadId}
    `;
    const count = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.lead_activities WHERE lead_id = ${leadId} AND type = 'anonymized'
    `;

    expect([first, second]).toEqual([true, false]);
    expect(again).toEqual(after);
    expect(count[0]?.n).toBe(1);
  });

  it('returns false for an unknown lead', async () => {
    const fixture = await scope.workspace();

    expect(await anonymize(fixture.workspaceId, ids.uuidv7())).toBe(false);
  });

  it('returns false and changes nothing for a lead of another workspace', async () => {
    const owner = await seedFullLead();
    const other = await scope.workspace();
    const before = await db.admin<Record<string, unknown>[]>`
      SELECT * FROM crm.leads WHERE id = ${owner.leadId}
    `;

    const result = await anonymize(other.workspaceId, owner.leadId);
    const after = await db.admin<Record<string, unknown>[]>`
      SELECT * FROM crm.leads WHERE id = ${owner.leadId}
    `;
    const activities = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.lead_activities WHERE lead_id = ${owner.leadId}
    `;

    expect(result).toBe(false);
    expect(after).toEqual(before);
    expect(activities[0]?.n).toBe(3);
  });

  it('returns false when no workspace is in scope', async () => {
    const { leadId } = await seedFullLead();

    const rows = await db.app<{ anonymized: boolean }[]>`
      SELECT crm.anonymize_lead(${leadId}, 'user', ${ids.uuidv7()}, ${ids.uuidv7()}) AS anonymized
    `;
    const [lead] = await db.admin<{ anonymized_at: Date | null }[]>`
      SELECT anonymized_at FROM crm.leads WHERE id = ${leadId}
    `;

    expect(rows[0]?.anonymized).toBe(false);
    expect(lead?.anonymized_at).toBeNull();
  });

  it('serializes concurrent calls: exactly one anonymizes', async () => {
    const { fixture, leadId } = await seedFullLead();

    const results = await Promise.all([
      anonymize(fixture.workspaceId, leadId),
      anonymize(fixture.workspaceId, leadId),
      anonymize(fixture.workspaceId, leadId),
    ]);
    const count = await db.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.lead_activities WHERE lead_id = ${leadId} AND type = 'anonymized'
    `;

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(count[0]?.n).toBe(1);
  });

  it('rolls back completely when the actor type is invalid', async () => {
    const { fixture, leadId } = await seedFullLead();

    await expect(anonymize(fixture.workspaceId, leadId, 'robot')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    const [lead] = await db.admin<{ anonymized_at: Date | null; first_name: string }[]>`
      SELECT anonymized_at, first_name FROM crm.leads WHERE id = ${leadId}
    `;
    const [note] = await db.admin<{ data: unknown }[]>`
      SELECT data FROM crm.lead_activities WHERE lead_id = ${leadId} AND type = 'note_added'
    `;

    expect(lead).toEqual({ anonymized_at: null, first_name: ORIGINAL.firstName });
    expect(note?.data).toEqual({ body: ORIGINAL.noteBody });
  });

  it('frees the e-mail: the same address can be inserted again as a new lead (AC-CRM-09)', async () => {
    const { fixture, leadId, email } = await seedFullLead();
    await anonymize(fixture.workspaceId, leadId);
    const returning = aLeadState(fixture.workspaceId, ids, { email });

    const outcome = await uow.run(fixture.workspaceId, (tx) => leads.insertIfAbsent(tx, returning));
    const active = await uow.run(fixture.workspaceId, (tx) =>
      leads.findActiveByEmailForUpdate(tx, fixture.workspaceId, email),
    );

    expect(outcome).toBe('inserted');
    expect(active?.id).toBe(returning.id);
    expect(active?.id).not.toBe(leadId);
  });

  it('does not loosen the append-only guard of the timeline', async () => {
    const { fixture, leadId } = await seedFullLead();
    await anonymize(fixture.workspaceId, leadId);

    // The flag lives and dies inside the function: a later statement cannot rewrite history.
    await expect(
      db.admin`UPDATE crm.lead_activities SET data = '{}'::jsonb WHERE lead_id = ${leadId}`,
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      db.admin`DELETE FROM crm.lead_activities WHERE lead_id = ${leadId}`,
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    // Even with a forged flag only `data` may change, never the type or the actor.
    await expect(
      db.admin.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('app.lead_anonymization', 'on', true)`;
        await tx`UPDATE crm.lead_activities SET type = 'note_added' WHERE lead_id = ${leadId}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });
});
