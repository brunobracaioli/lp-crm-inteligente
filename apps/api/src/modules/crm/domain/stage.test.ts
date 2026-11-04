import { describe, expect, it } from 'vitest';
import type { UserId } from '#/shared/ids.ts';
import { LEAD_STAGES, LOST_REASONS, type LeadStage } from '#/modules/crm/domain/lead-types.ts';
import { planStageChange, type Actor } from '#/modules/crm/domain/stage.ts';

const USER_ID = '00000000-0000-7000-8000-000000000001' as UserId;
const admin: Actor = { type: 'user', userId: USER_ID, role: 'admin' };
const owner: Actor = { type: 'user', userId: USER_ID, role: 'owner' };
const sales: Actor = { type: 'user', userId: USER_ID, role: 'sales' };
const viewer: Actor = { type: 'user', userId: USER_ID, role: 'viewer' };
const system: Actor = { type: 'system' };

/** The state diagram of crm §4, written independently of the implementation. */
const ALLOWED = new Set<string>([
  'new>contacted',
  'new>qualified',
  'new>lost',
  'contacted>qualified',
  'contacted>lost',
  'qualified>proposal',
  'qualified>lost',
  'proposal>won',
  'proposal>lost',
  'lost>contacted',
]);

const ALL_PAIRS = LEAD_STAGES.flatMap((from) => LEAD_STAGES.map((to) => [from, to] as const));

describe('stage machine', () => {
  it('AC-CRM-01: the table covers every ordered pair of stages (36)', () => {
    expect(ALL_PAIRS).toHaveLength(36);
    expect(ALL_PAIRS.filter(([from, to]) => ALLOWED.has(`${from}>${to}`))).toHaveLength(10);
  });

  it.each(ALL_PAIRS)('AC-CRM-01: %s -> %s follows the diagram', (from, to) => {
    // arrange
    const lostReason = to === 'lost' ? 'no_budget' : null;
    // act
    const result = planStageChange({ from, to, lostReason, by: admin });
    // assert
    if (ALLOWED.has(`${from}>${to}`)) {
      expect(result).toEqual({ ok: true, value: { stage: to, lostReason } });
    } else {
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_stage_transition', detail: `${from}->${to}` },
      });
    }
  });

  it('AC-CRM-01: new -> qualified is the only allowed skip', () => {
    const skips = ALL_PAIRS.filter(([from, to]) => {
      const distance = LEAD_STAGES.indexOf(to) - LEAD_STAGES.indexOf(from);
      return ALLOWED.has(`${from}>${to}`) && to !== 'lost' && distance > 1;
    });
    expect(skips).toEqual([['new', 'qualified']]);
  });

  it('AC-CRM-01: won is terminal for every actor', () => {
    for (const to of LEAD_STAGES) {
      const result = planStageChange({ from: 'won', to, lostReason: null, by: admin });
      expect(result.ok).toBe(false);
    }
  });

  it.each(['new', 'contacted', 'qualified', 'proposal'] as const)(
    'AC-CRM-02: moving %s to lost without a reason is lost_reason_required',
    (from) => {
      expect(planStageChange({ from, to: 'lost', lostReason: null, by: sales })).toEqual({
        ok: false,
        error: { code: 'lost_reason_required' },
      });
    },
  );

  it.each(LOST_REASONS)('accepts the lost reason %s', (reason) => {
    expect(
      planStageChange({ from: 'proposal', to: 'lost', lostReason: reason, by: sales }),
    ).toEqual({ ok: true, value: { stage: 'lost', lostReason: reason } });
  });

  it('rejects a lost reason outside the vocabulary', () => {
    expect(planStageChange({ from: 'new', to: 'lost', lostReason: 'because', by: sales })).toEqual({
      ok: false,
      error: { code: 'invalid_lost_reason' },
    });
  });

  it('rejects a lost reason on a stage that is not lost', () => {
    expect(
      planStageChange({ from: 'new', to: 'contacted', lostReason: 'no_budget', by: sales }),
    ).toEqual({ ok: false, error: { code: 'lost_reason_not_allowed' } });
  });

  it('checks the transition before the lost reason', () => {
    expect(planStageChange({ from: 'won', to: 'lost', lostReason: null, by: admin })).toEqual({
      ok: false,
      error: { code: 'invalid_stage_transition', detail: 'won->lost' },
    });
  });

  it.each([
    ['owner', owner],
    ['admin', admin],
  ])('reopening a lost lead is allowed for %s and clears the reason', (_role, by) => {
    expect(planStageChange({ from: 'lost', to: 'contacted', lostReason: null, by })).toEqual({
      ok: true,
      value: { stage: 'contacted', lostReason: null },
    });
  });

  it.each([
    ['sales', sales],
    ['viewer', viewer],
    ['system', system],
  ])('reopening a lost lead is refused for %s', (_role, by) => {
    expect(planStageChange({ from: 'lost', to: 'contacted', lostReason: null, by })).toEqual({
      ok: false,
      error: { code: 'reopen_not_allowed' },
    });
  });

  it('only the lost -> contacted transition requires a privileged role', () => {
    const lockedForSales = ALL_PAIRS.filter(([from, to]) => {
      const reason = to === 'lost' ? 'timing' : null;
      const result = planStageChange({ from, to, lostReason: reason, by: sales });
      return ALLOWED.has(`${from}>${to}`) && !result.ok;
    });
    expect(lockedForSales).toEqual([['lost', 'contacted']] satisfies [LeadStage, LeadStage][]);
  });
});
