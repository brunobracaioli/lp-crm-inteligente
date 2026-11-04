import { describe, expect, it } from 'vitest';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import {
  ADMIN_USER,
  CORRELATION,
  WORKSPACE_A,
  createCommandHarness,
} from '#test/fakes/crm-commands.ts';

const actor: StaffActor = { userId: ADMIN_USER, workspaceId: WORKSPACE_A, role: 'viewer' };

describe('recordDenial', () => {
  it('writes a denied audit row with the reason only', async () => {
    const h = createCommandHarness();

    const recorded = await h.recordDenial({
      actor,
      action: 'lead.data_exported',
      resourceType: 'lead',
      resourceId: '00000000-0000-7000-8000-000000000001',
      reason: 'mfa_required',
      correlationId: CORRELATION,
    });

    expect(recorded).toBe(true);
    expect(h.audit.entries).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_A,
        actorType: 'user',
        actorId: ADMIN_USER,
        action: 'lead.data_exported',
        result: 'denied',
        resourceId: '00000000-0000-7000-8000-000000000001',
        correlationId: CORRELATION,
        metadata: { reason: 'mfa_required' },
      }),
    ]);
  });

  it('uses the nil UUID when the target is not a valid lead id', async () => {
    const h = createCommandHarness();

    await h.recordDenial({
      actor,
      action: 'lead.exported',
      resourceType: 'lead_export',
      resourceId: null,
      reason: 'forbidden',
      correlationId: CORRELATION,
    });

    expect(h.audit.entries[0]?.resourceId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('resolves to false instead of throwing when the audit store is down', async () => {
    const h = createCommandHarness();
    h.unitOfWork.failure = new Error('database down');

    const recorded = await h.recordDenial({
      actor,
      action: 'lead.exported',
      resourceType: 'lead_export',
      resourceId: null,
      reason: 'forbidden',
      correlationId: CORRELATION,
    });

    expect(recorded).toBe(false);
  });
});
