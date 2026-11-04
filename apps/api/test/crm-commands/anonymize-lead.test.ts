import { describe, expect, it } from 'vitest';
import type { RawBody } from '#/modules/crm/application/commands/failures.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import type {
  AnonymizeLeadCommand,
  AnonymizationPreview,
} from '#/modules/crm/application/commands/anonymize-lead.ts';
import { PLAN_TTL_SECONDS } from '#/modules/crm/application/commands/anonymization-plan.ts';
import {
  ADMIN_USER,
  CORRELATION,
  KEY_1,
  KEY_2,
  OWNER_USER,
  SALES_USER,
  WORKSPACE_A,
  WORKSPACE_B,
  createCommandHarness,
  type CommandHarness,
} from '#test/fakes/crm-commands.ts';

const json = (value: unknown): RawBody => ({ kind: 'json', value });
const adminActor: StaffActor = { userId: ADMIN_USER, workspaceId: WORKSPACE_A, role: 'admin' };
const ownerActor: StaffActor = { userId: OWNER_USER, workspaceId: WORKSPACE_A, role: 'owner' };

function command(
  overrides: Partial<AnonymizeLeadCommand> & Pick<AnonymizeLeadCommand, 'leadId'>,
): AnonymizeLeadCommand {
  return {
    actor: adminActor,
    body: json({}),
    idempotencyKey: null,
    correlationId: CORRELATION,
    ...overrides,
  };
}

async function previewOf(
  h: CommandHarness,
  leadId: AnonymizeLeadCommand['leadId'],
  actor: StaffActor = adminActor,
): Promise<AnonymizationPreview> {
  const result = await h.anonymizeLead(command({ leadId, actor }));
  if (!result.ok || result.value.mode !== 'preview') {
    throw new Error('expected a preview');
  }
  return result.value;
}

const confirmBody = (planHash: string): RawBody => json({ confirm: true, plan_hash: planHash });

describe('anonymizeLead — preview', () => {
  it.each([[json({})], [json({ confirm: false })]])(
    'changes nothing and returns the plan for %j (AC-CRM-09)',
    async (body) => {
      // arrange
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, { ownerUserId: SALES_USER });
      const before = JSON.stringify(h.leads.all());
      // act
      const result = await h.anonymizeLead(command({ leadId: lead.id, body }));
      // assert
      expect(result).toMatchObject({
        ok: true,
        value: { mode: 'preview', leadId: lead.id, leadVersion: 3 },
      });
      expect(JSON.stringify(h.leads.all())).toBe(before);
      expect(h.activities.records).toHaveLength(0);
      expect(h.gateway.anonymizeCalls).toHaveLength(0);
      expect(h.audit.entries).toEqual([
        expect.objectContaining({
          action: 'lead.anonymize_previewed',
          result: 'success',
          metadata: { lead_version: 3 },
        }),
      ]);
    },
  );

  it('lists what will be erased (counts only) and what is kept', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A, { jobTitle: null, companyWebsite: null });

    const preview = await previewOf(h, lead.id);

    expect(preview.willErase).toEqual([
      { category: 'lead_contact_fields', count: 4 },
      { category: 'lead_company_fields', count: 1 },
      { category: 'attribution_snapshots', count: 2 },
      { category: 'submission_fields', count: 2 },
      { category: 'submission_messages', count: 1 },
      { category: 'submission_tracking_identifiers', count: 2 },
      { category: 'submission_ip_and_user_agent', count: 2 },
      { category: 'activity_notes', count: 1 },
    ]);
    expect(preview.willKeep).toEqual([
      'identifiers',
      'stage_and_score',
      'timestamps',
      'consent_history',
      'audit_trail',
    ]);
    expect(preview.planHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(preview.expiresAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
    expect(preview.expiresAt.getTime()).toBeLessThanOrEqual(
      h.clock.now().getTime() + PLAN_TTL_SECONDS * 1000,
    );
  });

  it('puts neither the hash nor any PII into the audit row', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const preview = await previewOf(h, lead.id);

    expect(JSON.stringify(h.audit.entries)).not.toContain(preview.planHash);
    expect(JSON.stringify(h.audit.entries)).not.toMatch(/maria|empresa|\+55/i);
  });

  it('answers not_found for another workspace and lead_anonymized for an erased lead', async () => {
    const h = createCommandHarness();
    const foreign = h.seed(WORKSPACE_B);
    const erased = h.seed(WORKSPACE_A, { anonymizedAt: new Date('2026-11-04T00:00:00Z') });

    expect(await h.anonymizeLead(command({ leadId: foreign.id }))).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await h.anonymizeLead(command({ leadId: erased.id }))).toEqual({
      ok: false,
      error: { code: 'lead_anonymized' },
    });
  });

  it('validates the body: plan_hash without confirm and unknown keys are 400', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const withHash = await h.anonymizeLead(
      command({ leadId: lead.id, body: json({ plan_hash: 'a'.repeat(43) }) }),
    );
    const extra = await h.anonymizeLead(
      command({ leadId: lead.id, body: json({ confirm: false, lead_id: 'x' }) }),
    );

    expect(withHash).toEqual({
      ok: false,
      error: { code: 'validation_failed', errors: [{ field: 'plan_hash', code: 'not_allowed' }] },
    });
    expect(extra).toEqual({
      ok: false,
      error: { code: 'validation_failed', errors: [{ field: 'lead_id', code: 'not_allowed' }] },
    });
  });
});

describe('anonymizeLead — apply', () => {
  it('erases through the database function, audits, and answers applied (AC-CRM-09)', async () => {
    // arrange
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    const preview = await previewOf(h, lead.id);
    // act
    const result = await h.anonymizeLead(
      command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
    );
    // assert
    expect(result).toMatchObject({
      ok: true,
      value: { mode: 'applied', leadId: lead.id, version: 4 },
    });
    expect(h.gateway.anonymizeCalls).toEqual([
      { leadId: lead.id, userId: ADMIN_USER, correlationId: CORRELATION },
    ]);
    expect(h.leads.all()[0]).toMatchObject({ firstName: 'Anonymized', version: 4 });
    expect(h.leads.all()[0]?.anonymizedAt).not.toBeNull();
    expect(h.auditActions()).toEqual([
      'lead.anonymize_previewed:success',
      'lead.anonymized:success',
    ]);
    expect(h.audit.entries[1]?.metadata).toEqual({ lead_version: 3, resulting_version: 4 });
  });

  it('requires plan_hash when confirm is true', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const result = await h.anonymizeLead(
      command({ leadId: lead.id, body: json({ confirm: true }), idempotencyKey: KEY_1 }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation_failed', errors: [{ field: 'plan_hash', code: 'required' }] },
    });
    expect(h.gateway.anonymizeCalls).toHaveLength(0);
  });

  it('requires an Idempotency-Key on confirmation', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    const preview = await previewOf(h, lead.id);

    const result = await h.anonymizeLead(
      command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: null }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'idempotency_key_missing' } });
    expect(h.gateway.anonymizeCalls).toHaveLength(0);
  });

  describe('plan_hash binding (ST-26)', () => {
    it('refuses a hash issued to another admin', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const preview = await previewOf(h, lead.id, ownerActor);

      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'plan_stale' } });
      expect(h.gateway.anonymizeCalls).toHaveLength(0);
    });

    it('refuses a hash issued for another lead', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const other = h.seed(WORKSPACE_A);
      const preview = await previewOf(h, other.id);

      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'plan_stale' } });
    });

    it('refuses a hash after the lead version changed', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const preview = await previewOf(h, lead.id);
      await h.changeLeadStage({
        actor: adminActor,
        leadId: lead.id,
        body: json({ to_stage: 'contacted', expected_version: 3 }),
        idempotencyKey: null,
        correlationId: CORRELATION,
      });

      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'plan_stale' } });
      expect(h.gateway.anonymizeCalls).toHaveLength(0);
    });

    it('refuses a hash after what would be erased changed (a note was added)', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const preview = await previewOf(h, lead.id);
      h.gateway.inventoryValue = { ...h.gateway.inventoryValue, activityNotes: 2 };

      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'plan_stale' } });
    });

    it('accepts the hash shortly before it expires', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const preview = await previewOf(h, lead.id);

      h.clock.advance((PLAN_TTL_SECONDS - 120) * 1000);
      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
      );

      expect(result).toMatchObject({ ok: true, value: { mode: 'applied' } });
    });

    it('refuses the hash once it has expired', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const preview = await previewOf(h, lead.id);

      h.clock.advance((PLAN_TTL_SECONDS + 1) * 1000);
      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'plan_stale' } });
      expect(h.gateway.anonymizeCalls).toHaveLength(0);
    });

    it('refuses a tampered hash', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const preview = await previewOf(h, lead.id);
      const tampered = `${preview.planHash.slice(0, 42)}${preview.planHash.endsWith('A') ? 'B' : 'A'}`;

      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody(tampered), idempotencyKey: KEY_1 }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'plan_stale' } });
    });

    it('rejects a malformed hash as a 400, not as stale', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.anonymizeLead(
        command({ leadId: lead.id, body: confirmBody('short'), idempotencyKey: KEY_1 }),
      );

      expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    });
  });

  it('answers lead_anonymized to a second application with a new key', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    const preview = await previewOf(h, lead.id);
    await h.anonymizeLead(
      command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
    );

    const again = await h.anonymizeLead(
      command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_2 }),
    );

    expect(again).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
    expect(h.gateway.anonymizeCalls).toHaveLength(1);
  });

  it('replays a repeated key with the stored result and does not call the function twice', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    const preview = await previewOf(h, lead.id);
    const cmd = command({
      leadId: lead.id,
      body: confirmBody(preview.planHash),
      idempotencyKey: KEY_1,
    });

    const first = await h.anonymizeLead(cmd);
    const second = await h.anonymizeLead(cmd);

    expect(second).toEqual(first);
    expect(h.gateway.anonymizeCalls).toHaveLength(1);
    expect(h.auditActions().filter((a) => a === 'lead.anonymized:success')).toHaveLength(1);
  });

  it('answers not_found for a lead of another workspace (AC-CRM-06)', async () => {
    const h = createCommandHarness();
    const foreign = h.seed(WORKSPACE_B);

    const result = await h.anonymizeLead(
      command({ leadId: foreign.id, body: confirmBody('a'.repeat(43)), idempotencyKey: KEY_1 }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(h.gateway.anonymizeCalls).toHaveLength(0);
  });

  it('rolls everything back when the database function reports the lead as gone', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    const preview = await previewOf(h, lead.id);
    h.gateway.anonymize = () => Promise.resolve(false);

    const result = await h.anonymizeLead(
      command({ leadId: lead.id, body: confirmBody(preview.planHash), idempotencyKey: KEY_1 }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
    expect(h.auditActions()).toEqual(['lead.anonymize_previewed:success']);
  });

  it.each([
    ['sales', { ...adminActor, userId: SALES_USER, role: 'sales' as const }],
    ['viewer', { ...adminActor, role: 'viewer' as const }],
  ])('refuses %s for preview and apply', async (_label, actor) => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const preview = await h.anonymizeLead(command({ leadId: lead.id, actor }));
    const apply = await h.anonymizeLead(
      command({
        leadId: lead.id,
        actor,
        body: confirmBody('a'.repeat(43)),
        idempotencyKey: KEY_1,
      }),
    );

    expect(preview).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(apply).toEqual({ ok: false, error: { code: 'forbidden' } });
  });
});
