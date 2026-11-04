import { describe, expect, it } from 'vitest';
import type { LeadId, SubmissionId, UserId, WorkspaceId } from '#/shared/ids.ts';
import { EMPTY_ATTRIBUTION } from '#/modules/crm/domain/attribution.ts';
import {
  Lead,
  type InboundContact,
  type LeadChange,
  type NewLeadInput,
  type SubmissionInput,
} from '#/modules/crm/domain/lead.ts';
import type { IcpProfile } from '#/modules/crm/domain/scoring-config.ts';
import type { Actor } from '#/modules/crm/domain/stage.ts';
import { Email, PhoneE164 } from '#/modules/crm/domain/value-objects.ts';

const LEAD_ID = '00000000-0000-7000-8000-0000000000a1' as LeadId;
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000b1' as WorkspaceId;
const SUBMISSION_1 = '00000000-0000-7000-8000-0000000000c1' as SubmissionId;
const SUBMISSION_2 = '00000000-0000-7000-8000-0000000000c2' as SubmissionId;
const OWNER_ID = '00000000-0000-7000-8000-0000000000d1' as UserId;
const OTHER_USER_ID = '00000000-0000-7000-8000-0000000000d2' as UserId;
const T1 = new Date('2026-11-03T12:00:00.000Z');
const T2 = new Date('2026-11-04T09:30:00.000Z');
const T3 = new Date('2026-11-05T09:30:00.000Z');

const ICP: IcpProfile = {
  priorityAreas: ['technology'],
  secondaryAreas: ['education'],
  seniorTitlePatterns: ['diretor', 'head'],
};

const admin: Actor = { type: 'user', userId: OWNER_ID, role: 'admin' };
const sales: Actor = { type: 'user', userId: OTHER_USER_ID, role: 'sales' };

const META_TOUCH = { ...EMPTY_ATTRIBUTION, utmSource: 'meta', fbclid: 'IwAR1' };
const DIRECT_TOUCH = { ...EMPTY_ATTRIBUTION, utmSource: 'direct' };

function aContact(overrides: Partial<InboundContact> = {}): InboundContact {
  return {
    firstName: 'Maria',
    lastName: 'Silva',
    email: 'maria@empresa.com.br',
    whatsappE164: '+5511912345678',
    companyName: 'Empresa Ltda',
    areaOfExpertise: 'health',
    areaOfExpertiseOther: null,
    jobTitle: null,
    companySize: null,
    companyWebsite: null,
    message: null,
    marketingOptIn: false,
    ...overrides,
  };
}

function newLeadInput(overrides: Partial<NewLeadInput> = {}): NewLeadInput {
  return {
    id: LEAD_ID,
    workspaceId: WORKSPACE_ID,
    submissionId: SUBMISSION_1,
    occurredAt: T1,
    contact: aContact(),
    attribution: META_TOUCH,
    ...overrides,
  };
}

function resubmission(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    submissionId: SUBMISSION_2,
    occurredAt: T2,
    contact: aContact(),
    attribution: DIRECT_TOUCH,
    ...overrides,
  };
}

function unwrap(
  result: { ok: true; value: LeadChange } | { ok: false; error: unknown },
): LeadChange {
  if (!result.ok) {
    throw new Error(`unexpected domain error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function registered(overrides: Partial<NewLeadInput> = {}): Lead {
  return unwrap(Lead.register(newLeadInput(overrides), ICP)).lead;
}

describe('Lead.register', () => {
  it('creates a lead in stage new with first_touch = last_touch and version 1', () => {
    // arrange
    const input = newLeadInput();
    // act
    const { lead, events } = unwrap(Lead.register(input, ICP));
    // assert
    expect(lead.toProps()).toMatchObject({
      id: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      email: 'maria@empresa.com.br',
      stage: 'new',
      lostReason: null,
      ownerUserId: null,
      submissionsCount: 1,
      firstTouch: META_TOUCH,
      lastTouch: META_TOUCH,
      firstSubmittedAt: T1,
      lastSubmittedAt: T1,
      anonymizedAt: null,
      version: 1,
      createdAt: T1,
      updatedAt: T1,
    });
    expect(events).toEqual([
      {
        type: 'SubmissionRegistered',
        leadId: LEAD_ID,
        occurredAt: T1,
        submissionId: SUBMISSION_1,
        score: lead.toProps().score,
        scoreBand: lead.scoreBand,
        submissionsCount: 1,
      },
    ]);
  });

  it('scores the new lead with the ICP and exposes the breakdown', () => {
    // arrange
    const contact = aContact({
      areaOfExpertise: 'technology',
      jobTitle: 'Head de Produto',
      companySize: '51_200',
    });
    // act
    const { lead } = unwrap(Lead.register(newLeadInput({ contact }), ICP));
    // assert
    expect(lead.toProps().score).toBe(20 + 15 + 15 + 10 + 10);
    expect(lead.scoreBand).toBe('A');
    expect(lead.toProps().scoreBreakdown.map((rule) => rule.ruleId)).toEqual([
      'fit_company_size',
      'fit_segment',
      'fit_seniority',
      'fit_corporate_email',
      'intent_paid_origin',
    ]);
  });

  it('uses the default ICP when the workspace has none', () => {
    const { lead } = unwrap(
      Lead.register(
        newLeadInput({ contact: aContact({ areaOfExpertise: 'marketing_advertising' }) }),
        null,
      ),
    );
    expect(lead.toProps().scoreBreakdown).toContainEqual({ ruleId: 'fit_segment', points: 15 });
  });

  it.each([
    ['e-mail', { email: 'Maria@Empresa.com' }, 'invalid_email'],
    ['WhatsApp', { whatsappE164: '11912345678' }, 'invalid_whatsapp'],
    ['name', { firstName: '' }, 'invalid_person_name'],
    ['company', { companyName: 'A' }, 'invalid_company_profile'],
    ['area', { areaOfExpertise: 'other' }, 'invalid_company_profile'],
  ])('rejects an invalid %s with a domain error', (_label, override, code) => {
    expect(Lead.register(newLeadInput({ contact: aContact(override) }), ICP)).toEqual({
      ok: false,
      error: { code },
    });
  });
});

describe('Lead.registerSubmission', () => {
  it('AC-CRM-05: preserves first_touch, updates last_touch and increments submissions_count', () => {
    // arrange
    const lead = registered();
    // act
    const { lead: next, events } = unwrap(lead.registerSubmission(resubmission(), ICP));
    // assert
    expect(next.toProps()).toMatchObject({
      submissionsCount: 2,
      firstTouch: META_TOUCH,
      lastTouch: DIRECT_TOUCH,
      firstSubmittedAt: T1,
      lastSubmittedAt: T2,
      updatedAt: T2,
      createdAt: T1,
      version: 1,
      id: LEAD_ID,
      stage: 'new',
    });
    expect(events[0]).toMatchObject({
      type: 'SubmissionRegistered',
      submissionId: SUBMISSION_2,
      submissionsCount: 2,
    });
  });

  it('never mutates the aggregate it was called on', () => {
    // arrange
    const lead = registered();
    const before = lead.toProps();
    // act
    lead.registerSubmission(resubmission(), ICP);
    // assert
    expect(lead.toProps()).toBe(before);
    expect(lead.toProps().submissionsCount).toBe(1);
  });

  it('R1: the latest non-empty contact data wins; empty optional values keep the old ones', () => {
    // arrange
    const lead = registered({
      contact: aContact({
        jobTitle: 'Analista',
        companySize: '2_10',
        companyWebsite: 'https://old.example.com',
        marketingOptIn: true,
      }),
    });
    const second = resubmission({
      contact: aContact({
        firstName: 'Mariana',
        whatsappE164: '+5521988887777',
        companyName: 'Nova Empresa',
        jobTitle: null,
        companySize: '51_200',
        companyWebsite: null,
        marketingOptIn: false,
      }),
    });
    // act
    const { lead: next } = unwrap(lead.registerSubmission(second, ICP));
    // assert
    expect(next.toProps()).toMatchObject({
      firstName: 'Mariana',
      whatsappE164: '+5521988887777',
      companyName: 'Nova Empresa',
      jobTitle: 'Analista',
      companySize: '51_200',
      companyWebsite: 'https://old.example.com',
      marketingOptIn: false,
      email: 'maria@empresa.com.br',
    });
  });

  it('keeps the area and its "other" description consistent with the database CHECK', () => {
    // arrange
    const lead = registered({
      contact: aContact({ areaOfExpertise: 'other', areaOfExpertiseOther: 'Gestao de frotas' }),
    });
    // act
    const { lead: next } = unwrap(
      lead.registerSubmission(
        resubmission({ contact: aContact({ areaOfExpertise: 'technology' }) }),
        ICP,
      ),
    );
    // assert
    expect(next.toProps().areaOfExpertise).toBe('technology');
    expect(next.toProps().areaOfExpertiseOther).toBeNull();
  });

  it('recomputes the score with the recurrence rule and raises ScoreChanged when the band moves', () => {
    // arrange: 20 + 15 + 15 + 10 = 60 (band B) alone; +15 recurrence = 75 (band A)
    const lead = registered({
      contact: aContact({
        areaOfExpertise: 'technology',
        jobTitle: 'Diretor',
        companySize: '51_200',
      }),
      attribution: DIRECT_TOUCH,
    });
    expect(lead.scoreBand).toBe('B');
    // act
    const { lead: next, events } = unwrap(
      lead.registerSubmission(
        resubmission({
          contact: aContact({
            areaOfExpertise: 'technology',
            jobTitle: 'Diretor',
            companySize: '51_200',
          }),
        }),
        ICP,
      ),
    );
    // assert
    expect(next.toProps().score).toBe(75);
    expect(next.scoreBand).toBe('A');
    expect(events.map((event) => event.type)).toEqual(['SubmissionRegistered', 'ScoreChanged']);
    expect(events[1]).toMatchObject({ previousBand: 'B', scoreBand: 'A', score: 75 });
  });

  it('does not raise ScoreChanged when the band stays the same', () => {
    const { events } = unwrap(registered().registerSubmission(resubmission(), ICP));
    expect(events.map((event) => event.type)).toEqual(['SubmissionRegistered']);
  });

  it('keeps counting paid origin from the first touch after a direct re-submission', () => {
    // arrange
    const lead = registered({ attribution: META_TOUCH });
    // act
    const { lead: next } = unwrap(lead.registerSubmission(resubmission(), ICP));
    // assert
    expect(next.toProps().scoreBreakdown).toContainEqual({
      ruleId: 'intent_paid_origin',
      points: 10,
    });
  });

  it('refuses a submission with another e-mail, an invalid contact or an anonymized lead', () => {
    const lead = registered();
    expect(
      lead.registerSubmission(
        resubmission({ contact: aContact({ email: 'other@empresa.com.br' }) }),
        ICP,
      ),
    ).toEqual({ ok: false, error: { code: 'email_mismatch' } });
    expect(
      lead.registerSubmission(resubmission({ contact: aContact({ whatsappE164: 'x' }) }), ICP),
    ).toEqual({ ok: false, error: { code: 'invalid_whatsapp' } });
    const { lead: anonymized } = unwrap(lead.anonymize({ by: admin, occurredAt: T2 }));
    expect(anonymized.registerSubmission(resubmission(), ICP)).toEqual({
      ok: false,
      error: { code: 'lead_anonymized' },
    });
  });
});

describe('Lead.changeStage', () => {
  it('moves through the pipeline and raises StageChanged', () => {
    // arrange
    const lead = registered();
    // act
    const { lead: next, events } = unwrap(
      lead.changeStage({ to: 'contacted', by: sales, occurredAt: T2 }),
    );
    // assert
    expect(next.stage).toBe('contacted');
    expect(next.toProps().updatedAt).toBe(T2);
    expect(lead.stage).toBe('new');
    expect(events).toEqual([
      {
        type: 'StageChanged',
        leadId: LEAD_ID,
        occurredAt: T2,
        from: 'new',
        to: 'contacted',
        lostReason: null,
        by: sales,
      },
    ]);
  });

  it('AC-CRM-02: lost without a reason is lost_reason_required and changes nothing', () => {
    const lead = registered();
    expect(lead.changeStage({ to: 'lost', by: sales, occurredAt: T2 })).toEqual({
      ok: false,
      error: { code: 'lost_reason_required' },
    });
    expect(lead.stage).toBe('new');
  });

  it('stores the reason when lost and clears it when an admin reopens the lead', () => {
    // arrange
    const lead = registered();
    const lost = unwrap(
      lead.changeStage({ to: 'lost', lostReason: 'no_budget', by: sales, occurredAt: T2 }),
    ).lead;
    // act
    const reopened = lost.changeStage({ to: 'contacted', by: admin, occurredAt: T3 });
    // assert
    expect(lost.toProps()).toMatchObject({ stage: 'lost', lostReason: 'no_budget' });
    expect(unwrap(reopened).lead.toProps()).toMatchObject({ stage: 'contacted', lostReason: null });
    expect(lost.changeStage({ to: 'contacted', by: sales, occurredAt: T3 })).toEqual({
      ok: false,
      error: { code: 'reopen_not_allowed' },
    });
  });

  it('rejects a transition outside the diagram and any change on an anonymized lead', () => {
    const lead = registered();
    expect(lead.changeStage({ to: 'won', by: admin, occurredAt: T2 }).ok).toBe(false);
    const { lead: anonymized } = unwrap(lead.anonymize({ by: admin, occurredAt: T2 }));
    expect(anonymized.changeStage({ to: 'contacted', by: admin, occurredAt: T3 })).toEqual({
      ok: false,
      error: { code: 'lead_anonymized' },
    });
  });
});

describe('Lead.assignOwner', () => {
  it('assigns an owner, replaces it and clears it, raising OwnerAssigned each time', () => {
    // arrange
    const lead = registered();
    // act
    const first = unwrap(lead.assignOwner({ ownerUserId: OWNER_ID, by: admin, occurredAt: T2 }));
    const second = unwrap(
      first.lead.assignOwner({ ownerUserId: OTHER_USER_ID, by: admin, occurredAt: T3 }),
    );
    const cleared = unwrap(
      second.lead.assignOwner({ ownerUserId: null, by: admin, occurredAt: T3 }),
    );
    // assert
    expect(first.lead.toProps().ownerUserId).toBe(OWNER_ID);
    expect(first.events).toEqual([
      {
        type: 'OwnerAssigned',
        leadId: LEAD_ID,
        occurredAt: T2,
        previousOwnerUserId: null,
        ownerUserId: OWNER_ID,
        by: admin,
      },
    ]);
    expect(second.events[0]).toMatchObject({
      previousOwnerUserId: OWNER_ID,
      ownerUserId: OTHER_USER_ID,
    });
    expect(cleared.lead.toProps().ownerUserId).toBeNull();
  });

  it('is a no-op without events when the owner does not change', () => {
    const lead = registered();
    const change = unwrap(lead.assignOwner({ ownerUserId: null, by: admin, occurredAt: T2 }));
    expect(change.lead).toBe(lead);
    expect(change.events).toEqual([]);
  });

  it('refuses to assign an anonymized lead', () => {
    const { lead } = unwrap(registered().anonymize({ by: admin, occurredAt: T2 }));
    expect(lead.assignOwner({ ownerUserId: OWNER_ID, by: admin, occurredAt: T3 })).toEqual({
      ok: false,
      error: { code: 'lead_anonymized' },
    });
  });
});

describe('Lead.anonymize', () => {
  it('replaces the PII with placeholders that still satisfy the database CHECKs', () => {
    // arrange
    const lead = registered({
      contact: aContact({
        areaOfExpertise: 'other',
        areaOfExpertiseOther: 'Gestao de frotas',
        jobTitle: 'Head',
        companyWebsite: 'https://empresa.com.br',
        marketingOptIn: true,
      }),
    });
    // act
    const { lead: anonymized, events } = unwrap(lead.anonymize({ by: admin, occurredAt: T2 }));
    // assert
    const props = anonymized.toProps();
    expect(props).toMatchObject({
      firstName: 'Anonymized',
      lastName: 'Anonymized',
      companyName: 'Anonymized',
      areaOfExpertiseOther: 'Anonymized',
      jobTitle: null,
      companyWebsite: null,
      marketingOptIn: false,
      firstTouch: EMPTY_ATTRIBUTION,
      lastTouch: EMPTY_ATTRIBUTION,
      anonymizedAt: T2,
      stage: 'new',
      score: lead.toProps().score,
      submissionsCount: 1,
    });
    expect(props.email).toBe(`anon+${LEAD_ID}@anonymized.invalid`);
    expect(Email.parse(props.email).ok).toBe(true);
    expect(PhoneE164.parse(props.whatsappE164).ok).toBe(true);
    expect(anonymized.isAnonymized).toBe(true);
    expect(events).toEqual([
      { type: 'LeadAnonymized', leadId: LEAD_ID, occurredAt: T2, by: admin },
    ]);
  });

  it('is irreversible: a second anonymization is refused', () => {
    const { lead } = unwrap(registered().anonymize({ by: admin, occurredAt: T2 }));
    expect(lead.anonymize({ by: admin, occurredAt: T3 })).toEqual({
      ok: false,
      error: { code: 'lead_anonymized' },
    });
  });

  it('keeps "other" null when the area is not other', () => {
    const { lead } = unwrap(registered().anonymize({ by: admin, occurredAt: T2 }));
    expect(lead.toProps().areaOfExpertiseOther).toBeNull();
  });
});

describe('Lead.rehydrate', () => {
  it('round-trips the persisted state and exposes identity accessors', () => {
    // arrange
    const props = registered().toProps();
    // act
    const lead = Lead.rehydrate(props);
    // assert
    expect(lead.toProps()).toBe(props);
    expect(lead.id).toBe(LEAD_ID);
    expect(lead.workspaceId).toBe(WORKSPACE_ID);
    expect(lead.version).toBe(1);
    expect(lead.isAnonymized).toBe(false);
  });
});
