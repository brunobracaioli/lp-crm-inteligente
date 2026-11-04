import { describe, expect, it } from 'vitest';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import {
  ADMIN_USER,
  CORRELATION,
  SALES_USER,
  WORKSPACE_A,
  WORKSPACE_B,
  createCommandHarness,
} from '#test/fakes/crm-commands.ts';

const adminActor: StaffActor = { userId: ADMIN_USER, workspaceId: WORKSPACE_A, role: 'admin' };

describe('exportLeadData', () => {
  it('returns the lead and everything held about it and audits the access', async () => {
    // arrange
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    h.subjectData.bundle = {
      submissions: [],
      consents: [],
      activities: [],
      truncated: true,
    };
    // act
    const result = await h.exportLeadData({
      actor: adminActor,
      leadId: lead.id,
      correlationId: CORRELATION,
    });
    // assert
    expect(result).toMatchObject({
      ok: true,
      value: { lead: { id: lead.id }, data: { truncated: true } },
    });
    expect(h.audit.entries).toEqual([
      expect.objectContaining({
        action: 'lead.data_exported',
        result: 'success',
        actorId: ADMIN_USER,
        resourceId: lead.id,
        metadata: { submissions: 0, consents: 0, activities: 0, truncated: true },
      }),
    ]);
  });

  it('answers not_found for another workspace (AC-CRM-06) and writes no audit', async () => {
    const h = createCommandHarness();
    const foreign = h.seed(WORKSPACE_B);

    const result = await h.exportLeadData({
      actor: adminActor,
      leadId: foreign.id,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(h.audit.entries).toHaveLength(0);
  });

  it('answers lead_anonymized: there is no personal data left to deliver', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A, { anonymizedAt: new Date('2026-11-04T00:00:00Z') });

    const result = await h.exportLeadData({
      actor: adminActor,
      leadId: lead.id,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
  });

  it('does not deliver data whose audit row failed to write', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    h.audit.append = () => Promise.reject(new Error('audit store down'));

    await expect(
      h.exportLeadData({ actor: adminActor, leadId: lead.id, correlationId: CORRELATION }),
    ).rejects.toThrow('audit store down');
  });

  it('refuses sales', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);

    const result = await h.exportLeadData({
      actor: { ...adminActor, userId: SALES_USER, role: 'sales' },
      leadId: lead.id,
      correlationId: CORRELATION,
    });

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });
});
