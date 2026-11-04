import { describe, expect, it, vi } from 'vitest';
import type { SubmissionId } from '#/shared/ids.ts';
import {
  InboundLeadRejectedError,
  LeadStateInconsistentError,
} from '#/modules/crm/application/register-inbound-lead.ts';
import {
  NO_ATTRIBUTION,
  OTHER_WORKSPACE_ID,
  WORKSPACE_ID,
  anInboundCommand,
  anInboundProfile,
  createCrmHarness,
} from './fakes/crm-harness.ts';

const FIRST_SUBMISSION = '00000000-0000-7000-8000-00000000aa01' as SubmissionId;
const SECOND_SUBMISSION = '00000000-0000-7000-8000-00000000aa02' as SubmissionId;
const META_TOUCH = { ...NO_ATTRIBUTION, utmSource: 'meta', fbclid: 'IwAR1' };
const DIRECT_TOUCH = { ...NO_ATTRIBUTION, utmSource: 'newsletter' };
const FIRST_AT = new Date('2026-11-03T12:00:00.000Z');
const SECOND_AT = new Date('2026-11-04T10:00:00.000Z');

describe('RegisterInboundLead: new lead (R1)', () => {
  it('creates the lead in stage new, reports isNew and records one submission_received activity', async () => {
    // arrange
    const crm = createCrmHarness();
    const command = anInboundCommand({ attribution: META_TOUCH });
    // act
    const result = await crm.register(command);
    // assert
    const stored = crm.leads.find(WORKSPACE_ID, 'maria@empresa.com.br');
    expect(result).toEqual({ leadId: stored?.id, isNew: true, scoreBand: stored?.scoreBand });
    expect(stored).toMatchObject({
      workspaceId: WORKSPACE_ID,
      stage: 'new',
      submissionsCount: 1,
      version: 1,
      firstTouch: META_TOUCH,
      lastTouch: META_TOUCH,
      firstSubmittedAt: FIRST_AT,
    });
    expect(crm.activities.records).toHaveLength(1);
    expect(crm.activities.records[0]).toMatchObject({
      leadId: stored?.id,
      workspaceId: WORKSPACE_ID,
      type: 'submission_received',
      actorType: 'system',
      actorId: null,
      createdAt: FIRST_AT,
      data: { submission_id: FIRST_SUBMISSION, submissions_count: 1 },
    });
  });

  it('never writes PII into the activity data', async () => {
    // arrange
    const crm = createCrmHarness();
    // act
    await crm.register(anInboundCommand());
    // assert
    const serialized = JSON.stringify(crm.activities.records.map((record) => record.data));
    for (const pii of ['Maria', 'Silva', 'maria@empresa.com.br', '+5511912345678', 'Empresa']) {
      expect(serialized).not.toContain(pii);
    }
  });

  it('writes inside the caller transaction: a rollback leaves nothing behind', async () => {
    // arrange
    const crm = createCrmHarness();
    // act
    const outcome = crm.unitOfWork.run(WORKSPACE_ID, async (tx) => {
      await crm.registerInboundLead(tx, anInboundCommand());
      throw new Error('later step failed');
    });
    // assert
    await expect(outcome).rejects.toThrow('later step failed');
    expect(crm.leads.all()).toHaveLength(0);
    expect(crm.activities.records).toHaveLength(0);
  });

  it('uses the workspace ICP when one is configured', async () => {
    // arrange
    const crm = createCrmHarness();
    crm.icp.icp = {
      priorityAreas: ['technology'],
      secondaryAreas: [],
      seniorTitlePatterns: ['analista'],
    };
    const command = anInboundCommand({
      profile: anInboundProfile({ jobTitle: 'Analista Senior' }),
    });
    // act
    await crm.register(command);
    // assert
    expect(crm.leads.find(WORKSPACE_ID, 'maria@empresa.com.br')?.scoreBreakdown).toEqual([
      { ruleId: 'fit_segment', points: 15 },
      { ruleId: 'fit_seniority', points: 15 },
      { ruleId: 'fit_corporate_email', points: 10 },
    ]);
  });

  it('falls back to the default ICP when the workspace has none', async () => {
    // arrange
    const crm = createCrmHarness();
    crm.icp.icp = null;
    // act
    await crm.register(
      anInboundCommand({ profile: anInboundProfile({ areaOfExpertise: 'marketing_advertising' }) }),
    );
    // assert
    expect(crm.leads.find(WORKSPACE_ID, 'maria@empresa.com.br')?.scoreBreakdown).toContainEqual({
      ruleId: 'fit_segment',
      points: 15,
    });
  });
});

describe('RegisterInboundLead: existing lead (R1, R5)', () => {
  it('AC-CRM-05: keeps one lead, preserves first_touch, replaces last_touch and counts the submission', async () => {
    // arrange
    const crm = createCrmHarness();
    const first = await crm.register(anInboundCommand({ attribution: META_TOUCH }));
    const second = anInboundCommand({
      submissionId: SECOND_SUBMISSION,
      occurredAt: SECOND_AT,
      attribution: DIRECT_TOUCH,
    });
    // act
    const result = await crm.register(second);
    // assert
    expect(result.leadId).toBe(first.leadId);
    expect(result.isNew).toBe(false);
    expect(crm.leads.all()).toHaveLength(1);
    expect(crm.leads.all()[0]).toMatchObject({
      submissionsCount: 2,
      firstTouch: META_TOUCH,
      lastTouch: DIRECT_TOUCH,
      firstSubmittedAt: FIRST_AT,
      lastSubmittedAt: SECOND_AT,
      version: 2,
    });
  });

  it('appends a second submission_received activity to the same lead', async () => {
    // arrange
    const crm = createCrmHarness();
    await crm.register(anInboundCommand());
    // act
    await crm.register(
      anInboundCommand({ submissionId: SECOND_SUBMISSION, occurredAt: SECOND_AT }),
    );
    // assert
    expect(crm.activities.records.map((record) => record.type)).toEqual([
      'submission_received',
      'submission_received',
    ]);
    expect(crm.activities.records[1]?.data).toMatchObject({
      submission_id: SECOND_SUBMISSION,
      submissions_count: 2,
    });
  });

  it('records score_changed when the recurrence points move the lead to another band', async () => {
    // arrange: 20 (size) + 5 (site) + 15 (seniority) + 15 (segment) + 10 (e-mail) = 65, band B
    const crm = createCrmHarness();
    crm.icp.icp = {
      priorityAreas: ['technology'],
      secondaryAreas: [],
      seniorTitlePatterns: ['diretor'],
    };
    const profile = anInboundProfile({
      companySize: '51_200',
      companyWebsite: 'https://empresa.com.br',
      jobTitle: 'Diretor',
    });
    const first = await crm.register(anInboundCommand({ profile }));
    // act: the second submission adds 15 recurrence points: 80, band A
    const second = await crm.register(
      anInboundCommand({ profile, submissionId: SECOND_SUBMISSION, occurredAt: SECOND_AT }),
    );
    // assert
    expect(first.scoreBand).toBe('B');
    expect(second.scoreBand).toBe('A');
    const changed = crm.activities.records.find((record) => record.type === 'score_changed');
    expect(changed).toMatchObject({
      createdAt: SECOND_AT,
      actorType: 'system',
      data: { from_band: 'B', to_band: 'A', score: 80 },
    });
  });

  it('does not record score_changed when the band is unchanged', async () => {
    // arrange
    const crm = createCrmHarness();
    await crm.register(anInboundCommand());
    // act
    await crm.register(
      anInboundCommand({ submissionId: SECOND_SUBMISSION, occurredAt: SECOND_AT }),
    );
    // assert
    expect(crm.activities.records.some((record) => record.type === 'score_changed')).toBe(false);
  });

  it('is race-safe: when a concurrent insert wins, the loser re-reads under lock and updates', async () => {
    // arrange: the winner commits between our lookup (miss) and our insert
    const crm = createCrmHarness();
    const winner = await crm.register(anInboundCommand());
    const winnerState = crm.leads.all()[0];
    if (winnerState === undefined) {
      throw new Error('seed failed');
    }
    const fresh = createCrmHarness();
    fresh.leads.beforeInsert = () => {
      fresh.leads.seed(winnerState);
    };
    // act
    const result = await fresh.register(
      anInboundCommand({ submissionId: SECOND_SUBMISSION, occurredAt: SECOND_AT }),
    );
    // assert
    expect(result).toMatchObject({ leadId: winner.leadId, isNew: false });
    expect(fresh.leads.all()).toHaveLength(1);
    expect(fresh.leads.all()[0]).toMatchObject({ submissionsCount: 2, version: 2 });
    expect(fresh.log.entries).toEqual([
      'uow.run',
      'leads.findActiveByEmailForUpdate',
      'leads.insertIfAbsent',
      'leads.findActiveByEmailForUpdate',
      'leads.update',
      'activities.append:submission_received',
    ]);
  });

  it('fails loudly when the lead cannot be read after losing the insert race', async () => {
    // arrange
    const crm = createCrmHarness();
    await crm.register(anInboundCommand());
    crm.leads.hideExisting = true;
    // act
    const outcome = crm.register(anInboundCommand({ submissionId: SECOND_SUBMISSION }));
    // assert
    await expect(outcome).rejects.toBeInstanceOf(LeadStateInconsistentError);
    expect(crm.leads.all()[0]?.submissionsCount).toBe(1);
  });

  it('fails loudly (and rolls back) when the optimistic lock is violated under a row lock', async () => {
    // arrange
    const crm = createCrmHarness();
    await crm.register(anInboundCommand());
    vi.spyOn(crm.leads, 'update').mockResolvedValueOnce('version_conflict');
    // act
    const outcome = crm.register(anInboundCommand({ submissionId: SECOND_SUBMISSION }));
    // assert
    await expect(outcome).rejects.toBeInstanceOf(LeadStateInconsistentError);
    expect(crm.activities.records).toHaveLength(1);
  });
});

describe('RegisterInboundLead: multi-tenancy and contract violations', () => {
  it('keeps the same e-mail in two workspaces as two independent leads', async () => {
    // arrange
    const crm = createCrmHarness();
    // act
    const a = await crm.register(anInboundCommand());
    const b = await crm.register(anInboundCommand({ workspaceId: OTHER_WORKSPACE_ID }));
    // assert
    expect(a.leadId).not.toBe(b.leadId);
    expect(a.isNew && b.isNew).toBe(true);
    expect(crm.leads.all()).toHaveLength(2);
  });

  it('refuses to write a command of another workspace than the transaction scope (RLS)', async () => {
    // arrange
    const crm = createCrmHarness();
    // act
    const outcome = crm.unitOfWork.run(WORKSPACE_ID, (tx) =>
      crm.registerInboundLead(tx, anInboundCommand({ workspaceId: OTHER_WORKSPACE_ID })),
    );
    // assert
    await expect(outcome).rejects.toThrow('RLS');
    expect(crm.leads.all()).toHaveLength(0);
  });

  it.each([
    ['e-mail', { email: 'Maria@Empresa.com' }, 'invalid_email'],
    ['WhatsApp', { whatsappE164: '11912345678' }, 'invalid_whatsapp'],
    ['company profile', { areaOfExpertise: 'other' as const }, 'invalid_company_profile'],
  ])('aborts the transaction on an invalid %s from the edge', async (_label, override, code) => {
    // arrange
    const crm = createCrmHarness();
    const command = anInboundCommand({ profile: anInboundProfile(override) });
    // act
    const outcome = crm.register(command);
    // assert
    await expect(outcome).rejects.toMatchObject({
      name: InboundLeadRejectedError.name,
      code,
    });
    expect(crm.leads.all()).toHaveLength(0);
    expect(crm.activities.records).toHaveLength(0);
  });

  it('also rejects an invalid profile for an existing lead without touching it', async () => {
    // arrange
    const crm = createCrmHarness();
    await crm.register(anInboundCommand());
    // act
    const outcome = crm.register(
      anInboundCommand({ profile: anInboundProfile({ whatsappE164: 'nope' }) }),
    );
    // assert
    await expect(outcome).rejects.toBeInstanceOf(InboundLeadRejectedError);
    expect(crm.leads.all()[0]).toMatchObject({ submissionsCount: 1, version: 1 });
  });
});
