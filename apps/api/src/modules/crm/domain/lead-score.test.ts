import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AREAS_OF_EXPERTISE, COMPANY_SIZES } from '#/shared/lead-profile.ts';
import {
  bandFor,
  normalizeForMatching,
  scoreLead,
  type ScoreProfile,
  type ScoreSignals,
} from '#/modules/crm/domain/lead-score.ts';
import {
  DEFAULT_ICP,
  SCORE_RULE_IDS,
  type IcpProfile,
} from '#/modules/crm/domain/scoring-config.ts';

const ICP: IcpProfile = {
  priorityAreas: ['marketing_advertising', 'technology'],
  secondaryAreas: ['education'],
  seniorTitlePatterns: ['ceo', 'fundador', 'socio', 'diretor', 'head', 'gerente', 'c-level'],
};

const COLD_PROFILE: ScoreProfile = {
  companySize: null,
  areaOfExpertise: 'health',
  jobTitle: null,
  email: 'pessoa@gmail.com',
  message: null,
  companyWebsite: null,
};
const COLD_SIGNALS: ScoreSignals = { submissionsCount: 1, paidOrigin: false };

function pointsOf(profile: Partial<ScoreProfile>, signals: Partial<ScoreSignals> = {}) {
  return scoreLead({ ...COLD_PROFILE, ...profile }, { ...COLD_SIGNALS, ...signals }, ICP);
}

describe('scoreLead rules (crm §5)', () => {
  it('scores a cold webmail lead at zero, band C', () => {
    expect(scoreLead(COLD_PROFILE, COLD_SIGNALS, ICP)).toEqual({
      value: 0,
      band: 'C',
      breakdown: [],
      rawTotal: 0,
    });
  });

  it.each([
    ['solo', 0],
    ['2_10', 8],
    ['11_50', 15],
    ['51_200', 20],
    ['201_1000', 20],
    ['1000_plus', 15],
  ] as const)('company size %s is worth %i points', (companySize, points) => {
    expect(pointsOf({ companySize }).value).toBe(points);
  });

  it('segment: priority 15, secondary 8, other 0', () => {
    expect(pointsOf({ areaOfExpertise: 'technology' }).breakdown).toEqual([
      { ruleId: SCORE_RULE_IDS.segment, points: 15 },
    ]);
    expect(pointsOf({ areaOfExpertise: 'education' }).breakdown).toEqual([
      { ruleId: SCORE_RULE_IDS.segment, points: 8 },
    ]);
    expect(pointsOf({ areaOfExpertise: 'legal' }).breakdown).toEqual([]);
  });

  it.each([
    ['Diretora Comercial', true],
    ['CEO', true],
    ['Sócio-fundador', true],
    ['Co-Fundador', true],
    ['Cofundador', false],
    ['Head de Marketing', true],
    ['C-Level Executive', true],
    ['Gerente de Contas', true],
    ['Overhead Analyst', false],
    ['Analista', false],
  ])('seniority: "%s" matches = %s', (jobTitle, matches) => {
    const rule = pointsOf({ jobTitle }).breakdown.find(
      (entry) => entry.ruleId === SCORE_RULE_IDS.seniority,
    );
    expect(rule?.points).toBe(matches ? 15 : undefined);
  });

  it('seniority matching ignores accents, including decomposed ones', () => {
    expect(normalizeForMatching('Sócio')).toBe('socio');
    expect(normalizeForMatching('So\u0301cio')).toBe('socio');
    expect(pointsOf({ jobTitle: 'So\u0301cio Diretor' }).value).toBe(15);
  });

  it('treats ICP patterns as literals, never as regular expressions', () => {
    const icp: IcpProfile = { ...ICP, seniorTitlePatterns: ['(', '.*', '[a-', ''] };
    const score = scoreLead({ ...COLD_PROFILE, jobTitle: 'Analista (Jr) x' }, COLD_SIGNALS, icp);
    expect(score.breakdown.some((entry) => entry.ruleId === SCORE_RULE_IDS.seniority)).toBe(true);
    const noMatch = scoreLead({ ...COLD_PROFILE, jobTitle: 'Analista' }, COLD_SIGNALS, icp);
    expect(noMatch.value).toBe(0);
  });

  it('corporate e-mail: any domain outside the webmail list is worth 10', () => {
    expect(pointsOf({ email: 'maria@empresa.com.br' }).breakdown).toEqual([
      { ruleId: SCORE_RULE_IDS.corporateEmail, points: 10 },
    ]);
    expect(pointsOf({ email: 'maria@uol.com.br' }).value).toBe(0);
    expect(pointsOf({ email: 'maria@gmail.com' }).value).toBe(0);
  });

  it('message intent starts at 40 characters', () => {
    expect(pointsOf({ message: 'a'.repeat(39) }).value).toBe(0);
    expect(pointsOf({ message: 'a'.repeat(40) }).breakdown).toEqual([
      { ruleId: SCORE_RULE_IDS.message, points: 10 },
    ]);
  });

  it('website, paid origin and recurrence add 5, 10 and 15', () => {
    expect(pointsOf({ companyWebsite: 'https://x.com' }).value).toBe(5);
    expect(pointsOf({}, { paidOrigin: true }).value).toBe(10);
    expect(pointsOf({}, { submissionsCount: 1 }).value).toBe(0);
    expect(pointsOf({}, { submissionsCount: 2 }).value).toBe(15);
  });

  it('AC-CRM-04: 51_200, priority area, "Diretora Comercial", corporate e-mail and gclid is band A', () => {
    // arrange
    const profile: ScoreProfile = {
      companySize: '51_200',
      areaOfExpertise: 'marketing_advertising',
      jobTitle: 'Diretora Comercial',
      email: 'ana@empresa.com.br',
      message: null,
      companyWebsite: null,
    };
    // act
    const score = scoreLead(profile, { submissionsCount: 1, paidOrigin: true }, ICP);
    // assert
    expect(score.band).toBe('A');
    expect(score.value).toBe(70);
    expect(score.breakdown).toEqual([
      { ruleId: SCORE_RULE_IDS.companySize, points: 20 },
      { ruleId: SCORE_RULE_IDS.segment, points: 15 },
      { ruleId: SCORE_RULE_IDS.seniority, points: 15 },
      { ruleId: SCORE_RULE_IDS.corporateEmail, points: 10 },
      { ruleId: SCORE_RULE_IDS.paidOrigin, points: 10 },
    ]);
  });

  it('caps at 100 and keeps the uncapped sum in rawTotal when weights exceed it', () => {
    const score = scoreLead(
      {
        companySize: '51_200',
        areaOfExpertise: 'technology',
        jobTitle: 'CEO',
        email: 'ceo@empresa.com.br',
        message: 'a'.repeat(80),
        companyWebsite: 'https://empresa.com.br',
      },
      { submissionsCount: 3, paidOrigin: true },
      ICP,
    );
    expect(score.rawTotal).toBe(100);
    expect(score.value).toBe(100);
  });

  it('falls back to the default ICP when the workspace has none', () => {
    const withDefault = scoreLead(COLD_PROFILE, COLD_SIGNALS, DEFAULT_ICP);
    expect(scoreLead(COLD_PROFILE, COLD_SIGNALS, null)).toEqual(withDefault);
    expect(scoreLead(COLD_PROFILE, COLD_SIGNALS)).toEqual(withDefault);
  });

  it.each([
    [0, 'C'],
    [39, 'C'],
    [40, 'B'],
    [69, 'B'],
    [70, 'A'],
    [100, 'A'],
  ] as const)('score %i is band %s', (value, band) => {
    expect(bandFor(value)).toBe(band);
  });
});

describe('scoreLead properties', () => {
  const profileArbitrary: fc.Arbitrary<ScoreProfile> = fc.record({
    companySize: fc.option(fc.constantFrom(...COMPANY_SIZES), { nil: null }),
    areaOfExpertise: fc.constantFrom(...AREAS_OF_EXPERTISE),
    jobTitle: fc.option(
      fc.oneof(fc.string({ unit: 'grapheme', maxLength: 40 }), fc.constantFrom('CEO', 'Diretora')),
      { nil: null },
    ),
    email: fc.oneof(fc.emailAddress(), fc.constantFrom('a@gmail.com', 'b@empresa.com.br')),
    message: fc.option(fc.string({ unit: 'grapheme', maxLength: 90 }), { nil: null }),
    companyWebsite: fc.option(fc.webUrl(), { nil: null }),
  });
  const signalsArbitrary: fc.Arbitrary<ScoreSignals> = fc.record({
    submissionsCount: fc.integer({ min: 1, max: 20 }),
    paidOrigin: fc.boolean(),
  });
  const icpArbitrary: fc.Arbitrary<IcpProfile | null> = fc.option(
    fc.record({
      priorityAreas: fc.subarray([...AREAS_OF_EXPERTISE]),
      secondaryAreas: fc.subarray([...AREAS_OF_EXPERTISE]),
      seniorTitlePatterns: fc.array(fc.string({ unit: 'grapheme', maxLength: 12 }), {
        maxLength: 6,
      }),
    }),
    { nil: null },
  );

  it('AC-CRM-03: is pure and deterministic: the same input yields the same output', () => {
    fc.assert(
      fc.property(profileArbitrary, signalsArbitrary, icpArbitrary, (profile, signals, icp) => {
        expect(scoreLead(profile, signals, icp)).toEqual(scoreLead(profile, signals, icp));
      }),
    );
  });

  it('AC-CRM-03: value is an integer in [0, 100] and band follows the thresholds', () => {
    fc.assert(
      fc.property(profileArbitrary, signalsArbitrary, icpArbitrary, (profile, signals, icp) => {
        const { value, band } = scoreLead(profile, signals, icp);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
        expect(band).toBe(value >= 70 ? 'A' : value >= 40 ? 'B' : 'C');
      }),
    );
  });

  it('AC-CRM-03: the breakdown sums to the value before the cap, with unique positive rules', () => {
    fc.assert(
      fc.property(profileArbitrary, signalsArbitrary, icpArbitrary, (profile, signals, icp) => {
        const { value, rawTotal, breakdown } = scoreLead(profile, signals, icp);
        const sum = breakdown.reduce((total, rule) => total + rule.points, 0);
        expect(sum).toBe(rawTotal);
        expect(value).toBe(Math.min(100, rawTotal));
        expect(new Set(breakdown.map((rule) => rule.ruleId)).size).toBe(breakdown.length);
        expect(breakdown.every((rule) => rule.points > 0)).toBe(true);
      }),
    );
  });
});
