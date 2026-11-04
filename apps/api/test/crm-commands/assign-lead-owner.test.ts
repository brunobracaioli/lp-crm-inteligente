import { describe, expect, it } from 'vitest';
import type { RawBody } from '#/modules/crm/application/commands/failures.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import type { AssignLeadOwnerCommand } from '#/modules/crm/application/commands/assign-lead-owner.ts';
import type { UserId } from '#/shared/ids.ts';
import {
  ADMIN_USER,
  CORRELATION,
  KEY_1,
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
const salesActor: StaffActor = { userId: SALES_USER, workspaceId: WORKSPACE_A, role: 'sales' };
const STRANGER = '00000000-0000-7000-8000-0000000000ff' as UserId;

function command(
  overrides: Partial<AssignLeadOwnerCommand> & Pick<AssignLeadOwnerCommand, 'leadId'>,
): AssignLeadOwnerCommand {
  return {
    actor: adminActor,
    body: json({ owner_user_id: SALES_USER, expected_version: 3 }),
    idempotencyKey: null,
    correlationId: CORRELATION,
    ...overrides,
  };
}

describe('assignLeadOwner', () => {
  it('assigns an active member, bumps the version and records activity and audit', async () => {
    // arrange
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    // act
    const result = await h.assignLeadOwner(command({ leadId: lead.id }));
    // assert
    expect(result).toMatchObject({ ok: true, value: { ownerUserId: SALES_USER, version: 4 } });
    expect(h.activities.records.map((a) => a.type)).toEqual(['owner_assigned']);
    expect(h.activities.records[0]?.data).toEqual({
      previous_owner_id: null,
      owner_id: SALES_USER,
    });
    expect(h.audit.entries).toEqual([
      expect.objectContaining({
        action: 'lead.owner_assigned',
        result: 'success',
        metadata: { from_owner_user_id: null, to_owner_user_id: SALES_USER, changed: true },
      }),
    ]);
  });

  it('removes the owner with null', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A, { ownerUserId: SALES_USER });

    const result = await h.assignLeadOwner(
      command({ leadId: lead.id, body: json({ owner_user_id: null, expected_version: 3 }) }),
    );

    expect(result).toMatchObject({ ok: true, value: { ownerUserId: null, version: 4 } });
  });

  it('is a no-op for the current owner: no version bump, no timeline row, still audited', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A, { ownerUserId: SALES_USER });

    const result = await h.assignLeadOwner(command({ leadId: lead.id }));

    expect(result).toMatchObject({ ok: true, value: { ownerUserId: SALES_USER, version: 3 } });
    expect(h.activities.records).toHaveLength(0);
    expect(h.audit.entries[0]?.metadata).toMatchObject({ changed: false });
  });

  it.each([
    ['a user that is not a member', STRANGER],
    ['a member of another workspace', '00000000-0000-7000-8000-0000000000b9'],
  ])('rejects %s with owner_user_id/invalid_choice (C19)', async (_label, target) => {
    const h = createCommandHarness();
    h.members.add(WORKSPACE_B, '00000000-0000-7000-8000-0000000000b9' as UserId);
    const lead = h.seed(WORKSPACE_A);

    const result = await h.assignLeadOwner(
      command({ leadId: lead.id, body: json({ owner_user_id: target, expected_version: 3 }) }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation_failed',
        errors: [{ field: 'owner_user_id', code: 'invalid_choice' }],
      },
    });
    expect(h.leads.all()[0]?.ownerUserId).toBeNull();
  });

  it('rejects an inactive member', async () => {
    const h = createCommandHarness();
    h.members.active.delete(`${WORKSPACE_A}:${SALES_USER}`);
    const lead = h.seed(WORKSPACE_A);

    const result = await h.assignLeadOwner(command({ leadId: lead.id }));

    expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });

  it('answers version_conflict for a stale expected_version and changes nothing', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const result = await h.assignLeadOwner(
      command({ leadId: lead.id, body: json({ owner_user_id: SALES_USER, expected_version: 2 }) }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'version_conflict' } });
    expect(h.leads.all()[0]).toMatchObject({ ownerUserId: null, version: 3 });
    expect(h.activities.records).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  it('refuses an anonymized lead', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A, { anonymizedAt: new Date('2026-11-04T00:00:00Z') });

    const result = await h.assignLeadOwner(command({ leadId: lead.id }));

    expect(result).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
  });

  it('answers not_found for a lead of another workspace, before looking at the body (ST-13)', async () => {
    const h = createCommandHarness();
    const foreign = h.seed(WORKSPACE_B);

    const result = await h.assignLeadOwner(
      command({ leadId: foreign.id, body: { kind: 'invalid_json' } }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it.each([
    [{ owner_user_id: SALES_USER }, 'expected_version', 'required'],
    [{ expected_version: 3 }, 'owner_user_id', 'required'],
    [{ owner_user_id: 'not-a-uuid', expected_version: 3 }, 'owner_user_id', 'invalid_format'],
    [{ owner_user_id: null, expected_version: 3, stage: 'won' }, 'stage', 'not_allowed'],
  ])('validates the strict body %j', async (body, field, code) => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const result = await h.assignLeadOwner(command({ leadId: lead.id, body: json(body) }));

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation_failed', errors: [{ field, code }] },
    });
  });

  it.each<[string, StaffActor]>([
    ['sales', salesActor],
    ['viewer', { userId: VIEWER_USER, workspaceId: WORKSPACE_A, role: 'viewer' }],
  ])('refuses %s and audits the denial', async (_label, actor) => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const result = await h.assignLeadOwner(command({ leadId: lead.id, actor }));

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(h.leads.all()[0]?.ownerUserId).toBeNull();
    expect(h.audit.entries[0]).toMatchObject({
      action: 'lead.owner_assigned',
      result: 'denied',
      actorId: actor.userId,
    });
  });

  it('lets the workspace owner role assign too', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A, { ownerUserId: OTHER_SALES_USER });

    const result = await h.assignLeadOwner(
      command({
        leadId: lead.id,
        actor: { userId: OWNER_USER, workspaceId: WORKSPACE_A, role: 'owner' },
      }),
    );

    expect(result).toMatchObject({ ok: true, value: { ownerUserId: SALES_USER } });
  });

  it('replays a repeated key without a second timeline row', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    const cmd = command({ leadId: lead.id, idempotencyKey: KEY_1 });

    const first = await h.assignLeadOwner(cmd);
    const second = await h.assignLeadOwner(cmd);

    expect(second).toEqual(first);
    expect(h.activities.records).toHaveLength(1);
  });
});
