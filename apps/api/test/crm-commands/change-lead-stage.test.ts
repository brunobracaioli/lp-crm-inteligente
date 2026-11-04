import { describe, expect, it } from 'vitest';
import type { RawBody } from '#/modules/crm/application/commands/failures.ts';
import { requestHashOf } from '#/modules/crm/application/commands/idempotent.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import type { ChangeLeadStageCommand } from '#/modules/crm/application/commands/change-lead-stage.ts';
import {
  ADMIN_USER,
  CORRELATION,
  KEY_1,
  KEY_2,
  OTHER_SALES_USER,
  OWNER_USER,
  SALES_USER,
  VIEWER_USER,
  WORKSPACE_A,
  WORKSPACE_B,
  createCommandHarness,
} from '#test/fakes/crm-commands.ts';

const json = (value: unknown): RawBody => ({ kind: 'json', value });
const adminActor: StaffActor = { userId: ADMIN_USER, workspaceId: WORKSPACE_A, role: 'admin' };
const ownerActor: StaffActor = { userId: OWNER_USER, workspaceId: WORKSPACE_A, role: 'owner' };
const salesActor: StaffActor = { userId: SALES_USER, workspaceId: WORKSPACE_A, role: 'sales' };
const viewerActor: StaffActor = { userId: VIEWER_USER, workspaceId: WORKSPACE_A, role: 'viewer' };

function command(
  overrides: Partial<ChangeLeadStageCommand> & Pick<ChangeLeadStageCommand, 'leadId'>,
): ChangeLeadStageCommand {
  return {
    actor: adminActor,
    body: json({ to_stage: 'contacted', expected_version: 3 }),
    idempotencyKey: null,
    correlationId: CORRELATION,
    ...overrides,
  };
}

describe('changeLeadStage', () => {
  it('moves the lead, bumps the version and writes the timeline and exactly one audit row', async () => {
    // arrange
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    // act
    const result = await h.changeLeadStage(command({ leadId: lead.id }));
    // assert
    expect(result).toMatchObject({ ok: true, value: { stage: 'contacted', version: 4 } });
    expect(h.activities.records.map((a) => a.type)).toEqual(['stage_changed']);
    expect(h.activities.records[0]?.data).toEqual({
      from: 'new',
      to: 'contacted',
      lost_reason: null,
    });
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({
      action: 'lead.stage_changed',
      result: 'success',
      actorId: ADMIN_USER,
      resourceId: lead.id,
      metadata: { from_stage: 'new', to_stage: 'contacted', auto_assigned: false, version: 4 },
    });
    expect(h.leadReader.lockedReads).toBe(1);
  });

  it('enqueues the outbox event only for qualified and won', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    await h.changeLeadStage(command({ leadId: lead.id }));
    expect(h.stageOutbox.events).toHaveLength(0);

    await h.changeLeadStage(
      command({ leadId: lead.id, body: json({ to_stage: 'qualified', expected_version: 4 }) }),
    );
    expect(h.stageOutbox.events).toEqual([
      expect.objectContaining({ leadId: lead.id, toStage: 'qualified', workspaceId: WORKSPACE_A }),
    ]);
  });

  it('stores the lost reason when moving to lost', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A, { stage: 'contacted' });

    const result = await h.changeLeadStage(
      command({
        leadId: lead.id,
        body: json({ to_stage: 'lost', lost_reason: 'no_budget', expected_version: 3 }),
      }),
    );

    expect(result).toMatchObject({ ok: true, value: { stage: 'lost', lostReason: 'no_budget' } });
  });

  describe('optimistic lock (AC-CRM-08)', () => {
    it('answers version_conflict and changes nothing when expected_version is stale', async () => {
      // arrange
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      // act
      const result = await h.changeLeadStage(
        command({ leadId: lead.id, body: json({ to_stage: 'contacted', expected_version: 2 }) }),
      );
      // assert
      expect(result).toEqual({ ok: false, error: { code: 'version_conflict' } });
      expect(h.leads.all()[0]).toMatchObject({ stage: 'new', version: 3 });
      expect(h.activities.records).toHaveLength(0);
      expect(h.audit.entries).toHaveLength(0);
      expect(h.stageOutbox.events).toHaveLength(0);
    });

    it('lets exactly one of two requests with the same version win', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const body = json({ to_stage: 'contacted', expected_version: 3 });

      const first = await h.changeLeadStage(command({ leadId: lead.id, body }));
      const second = await h.changeLeadStage(command({ leadId: lead.id, body }));

      expect(first.ok).toBe(true);
      expect(second).toEqual({ ok: false, error: { code: 'version_conflict' } });
      expect(h.activities.records).toHaveLength(1);
    });
  });

  describe('state machine', () => {
    it.each([
      ['new', 'proposal'],
      ['new', 'won'],
      ['contacted', 'proposal'],
      ['qualified', 'won'],
      ['won', 'lost'],
      ['won', 'contacted'],
      ['lost', 'qualified'],
      ['contacted', 'contacted'],
    ] as const)('refuses %s → %s with invalid_stage_transition', async (from, to) => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, {
        stage: from,
        lostReason: from === 'lost' ? 'timing' : null,
      });
      const body =
        to === 'lost'
          ? { to_stage: to, lost_reason: 'timing', expected_version: 3 }
          : { to_stage: to, expected_version: 3 };

      const result = await h.changeLeadStage(command({ leadId: lead.id, body: json(body) }));

      expect(result).toEqual({ ok: false, error: { code: 'invalid_stage_transition' } });
      expect(h.leads.all()[0]?.stage).toBe(from);
      expect(h.audit.entries).toHaveLength(0);
    });

    it('lets owner and admin reopen a lost lead to contacted', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, { stage: 'lost', lostReason: 'timing' });

      const result = await h.changeLeadStage(command({ leadId: lead.id, actor: ownerActor }));

      expect(result).toMatchObject({ ok: true, value: { stage: 'contacted', lostReason: null } });
    });

    it('refuses an anonymized lead before it looks at the version', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, { anonymizedAt: new Date('2026-11-04T00:00:00Z') });

      const result = await h.changeLeadStage(
        command({ leadId: lead.id, body: json({ to_stage: 'contacted', expected_version: 1 }) }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
    });
  });

  describe('body validation', () => {
    it.each([
      [{ to_stage: 'lost', expected_version: 3 }, 'lost_reason', 'required'],
      [
        { to_stage: 'contacted', lost_reason: 'timing', expected_version: 3 },
        'lost_reason',
        'not_allowed',
      ],
      [{ to_stage: 'new', expected_version: 3 }, 'to_stage', 'invalid_choice'],
      [{ to_stage: 'bogus', expected_version: 3 }, 'to_stage', 'invalid_choice'],
      [{ expected_version: 3 }, 'to_stage', 'required'],
      [{ to_stage: 'contacted' }, 'expected_version', 'required'],
      [{ to_stage: 'contacted', expected_version: 0 }, 'expected_version', 'invalid_format'],
      [{ to_stage: 'contacted', expected_version: '3' }, 'expected_version', 'invalid_format'],
      [
        { to_stage: 'contacted', expected_version: 3, owner_user_id: SALES_USER },
        'owner_user_id',
        'not_allowed',
      ],
      [
        { to_stage: 'contacted', expected_version: 3, workspace_id: WORKSPACE_B },
        'workspace_id',
        'not_allowed',
      ],
    ])('rejects %j with %s/%s', async (body, field, code) => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.changeLeadStage(command({ leadId: lead.id, body: json(body) }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation_failed', errors: [{ field, code }] },
      });
      expect(h.leads.all()[0]?.version).toBe(3);
    });

    it('rejects a body that is not an object', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.changeLeadStage(command({ leadId: lead.id, body: json([1]) }));

      expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    });

    it('reports an unreadable body only after the resource checks', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const foreign = h.seed(WORKSPACE_B);

      const malformed = await h.changeLeadStage(
        command({ leadId: lead.id, body: { kind: 'invalid_json' } }),
      );
      const wrongType = await h.changeLeadStage(
        command({ leadId: lead.id, body: { kind: 'unsupported_media_type' } }),
      );
      const otherTenant = await h.changeLeadStage(
        command({ leadId: foreign.id, body: { kind: 'invalid_json' } }),
      );

      expect(malformed).toEqual({ ok: false, error: { code: 'invalid_json' } });
      expect(wrongType).toEqual({ ok: false, error: { code: 'unsupported_media_type' } });
      expect(otherTenant).toEqual({ ok: false, error: { code: 'not_found' } });
    });
  });

  describe('authorization (threat model C15)', () => {
    it('answers not_found for a lead of another workspace (AC-CRM-06)', async () => {
      const h = createCommandHarness();
      const foreign = h.seed(WORKSPACE_B);

      const result = await h.changeLeadStage(command({ leadId: foreign.id }));

      expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
      expect(h.leads.all()[0]).toMatchObject({ stage: 'new', version: 3 });
      expect(h.audit.entries).toHaveLength(0);
    });

    it('answers not_found for an unknown lead', async () => {
      const h = createCommandHarness();
      const result = await h.changeLeadStage(
        command({ leadId: '00000000-0000-7000-8000-00000000dead' as never }),
      );
      expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
    });

    it('lets sales change the stage of their own lead without touching the owner', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, { ownerUserId: SALES_USER });

      const result = await h.changeLeadStage(command({ leadId: lead.id, actor: salesActor }));

      expect(result).toMatchObject({
        ok: true,
        value: { stage: 'contacted', ownerUserId: SALES_USER },
      });
      expect(h.activities.records.map((a) => a.type)).toEqual(['stage_changed']);
    });

    it('makes sales the owner of an unowned lead they move, in the same commit (G6)', async () => {
      // arrange
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      // act
      const result = await h.changeLeadStage(command({ leadId: lead.id, actor: salesActor }));
      // assert
      expect(result).toMatchObject({
        ok: true,
        value: { stage: 'contacted', ownerUserId: SALES_USER, version: 4 },
      });
      expect(h.activities.records.map((a) => a.type)).toEqual(['owner_assigned', 'stage_changed']);
      expect(h.audit.entries).toHaveLength(1);
      expect(h.audit.entries[0]?.metadata).toMatchObject({ auto_assigned: true });
    });

    it('does not assign the lead when the stage change itself is refused', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.changeLeadStage(
        command({
          leadId: lead.id,
          actor: salesActor,
          body: json({ to_stage: 'won', expected_version: 3 }),
        }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'invalid_stage_transition' } });
      expect(h.leads.all()[0]?.ownerUserId).toBeNull();
    });

    it('does not make owner or admin the owner of an unowned lead', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.changeLeadStage(command({ leadId: lead.id, actor: adminActor }));

      expect(result).toMatchObject({ ok: true, value: { ownerUserId: null } });
    });

    it('refuses sales on a lead owned by someone else and audits the denial', async () => {
      // arrange
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, { ownerUserId: OTHER_SALES_USER });
      // act
      const result = await h.changeLeadStage(command({ leadId: lead.id, actor: salesActor }));
      // assert
      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
      expect(h.leads.all()[0]).toMatchObject({ stage: 'new', version: 3 });
      expect(h.activities.records).toHaveLength(0);
      expect(h.audit.entries).toEqual([
        expect.objectContaining({
          action: 'lead.stage_changed',
          result: 'denied',
          actorId: SALES_USER,
          metadata: { reason: 'not_owner' },
        }),
      ]);
    });

    it('refuses viewer', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.changeLeadStage(command({ leadId: lead.id, actor: viewerActor }));

      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
      expect(h.leads.all()[0]?.stage).toBe('new');
    });

    it('refuses sales reopening a lost lead and audits it (ST-11)', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, {
        stage: 'lost',
        lostReason: 'timing',
        ownerUserId: SALES_USER,
      });

      const result = await h.changeLeadStage(command({ leadId: lead.id, actor: salesActor }));

      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
      expect(h.leads.all()[0]?.stage).toBe('lost');
      expect(h.audit.entries[0]).toMatchObject({
        result: 'denied',
        metadata: { reason: 'reopen_not_allowed' },
      });
    });
  });

  describe('idempotency (ST-24)', () => {
    it('answers a repeated key and body with the same lead and writes once', async () => {
      // arrange
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const cmd = command({ leadId: lead.id, idempotencyKey: KEY_1 });
      // act
      const first = await h.changeLeadStage(cmd);
      const second = await h.changeLeadStage(cmd);
      // assert
      expect(first.ok && second.ok).toBe(true);
      expect(second).toEqual(first);
      expect(h.activities.records).toHaveLength(1);
      expect(h.audit.entries).toHaveLength(1);
    });

    it('rejects the same key with another body', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      await h.changeLeadStage(command({ leadId: lead.id, idempotencyKey: KEY_1 }));

      const result = await h.changeLeadStage(
        command({
          leadId: lead.id,
          idempotencyKey: KEY_1,
          body: json({ to_stage: 'qualified', expected_version: 4 }),
        }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'idempotency_key_reused' } });
      expect(h.leads.all()[0]?.stage).toBe('contacted');
    });

    it('treats key order in the body as the same intent', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      await h.changeLeadStage(
        command({
          leadId: lead.id,
          idempotencyKey: KEY_1,
          body: json({ to_stage: 'contacted', expected_version: 3 }),
        }),
      );

      const replay = await h.changeLeadStage(
        command({
          leadId: lead.id,
          idempotencyKey: KEY_1,
          body: json({ expected_version: 3, to_stage: 'contacted' }),
        }),
      );

      expect(replay.ok).toBe(true);
      expect(h.activities.records).toHaveLength(1);
    });

    it('answers idempotency_in_progress while the twin is running', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const scope = {
        workspaceId: WORKSPACE_A,
        userId: ADMIN_USER,
        operation: 'stage',
        resourceId: lead.id,
        key: KEY_1,
      } as const;
      // a request that claimed the key and has not finished
      await h.idempotency.claim(
        scope,
        requestHashOf('stage', { to_stage: 'contacted', expected_version: 3 }),
      );

      const twin = await h.changeLeadStage(command({ leadId: lead.id, idempotencyKey: KEY_1 }));
      await h.idempotency.claim({ ...scope, key: KEY_2 }, 'a-different-intent');
      const other = await h.changeLeadStage(command({ leadId: lead.id, idempotencyKey: KEY_2 }));

      expect(twin).toEqual({
        ok: false,
        error: { code: 'idempotency_in_progress', retryAfterSeconds: 1 },
      });
      expect(other).toEqual({ ok: false, error: { code: 'idempotency_key_reused' } });
      expect(h.activities.records).toHaveLength(0);
    });

    it('releases the claim after a failure so the client can retry', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const stale = command({
        leadId: lead.id,
        idempotencyKey: KEY_1,
        body: json({ to_stage: 'contacted', expected_version: 1 }),
      });
      expect(await h.changeLeadStage(stale)).toEqual({
        ok: false,
        error: { code: 'version_conflict' },
      });

      const fixed = await h.changeLeadStage(command({ leadId: lead.id, idempotencyKey: KEY_1 }));

      expect(fixed.ok).toBe(true);
    });

    it('does not replay the answer of another user or another key', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      await h.changeLeadStage(command({ leadId: lead.id, idempotencyKey: KEY_1 }));

      const otherUser = await h.changeLeadStage(
        command({ leadId: lead.id, idempotencyKey: KEY_1, actor: ownerActor }),
      );
      const otherKey = await h.changeLeadStage(command({ leadId: lead.id, idempotencyKey: KEY_2 }));

      expect(otherUser).toEqual({ ok: false, error: { code: 'version_conflict' } });
      expect(otherKey).toEqual({ ok: false, error: { code: 'version_conflict' } });
    });

    it('still works when the idempotency store is down (the optimistic lock protects)', async () => {
      const h = createCommandHarness();
      h.idempotency.unavailable = true;
      const lead = h.seed(WORKSPACE_A);

      const result = await h.changeLeadStage(command({ leadId: lead.id, idempotencyKey: KEY_1 }));

      expect(result.ok).toBe(true);
    });
  });
});
