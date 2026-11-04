import { describe, expect, it } from 'vitest';
import { activityDataForContract } from './activity-data.ts';
import { escapeLikePattern } from './postgres-lead-queries.ts';

const A = '0194f1c2-1111-7000-8000-00000000000a';
const B = '0194f1c2-1111-7000-8000-00000000000b';

describe('activityDataForContract', () => {
  it('maps the stage keys the domain writes (from/to) to the contract names', () => {
    expect(
      activityDataForContract('stage_changed', { from: 'new', to: 'lost', lost_reason: 'timing' }),
    ).toEqual({ from_stage: 'new', to_stage: 'lost', lost_reason: 'timing' });
  });

  it('accepts the contract names as well', () => {
    expect(
      activityDataForContract('stage_changed', { from_stage: 'qualified', to_stage: 'proposal' }),
    ).toEqual({ from_stage: 'qualified', to_stage: 'proposal' });
  });

  it('maps owner keys, keeping null as a value', () => {
    expect(
      activityDataForContract('owner_assigned', { previous_owner_id: null, owner_id: A }),
    ).toEqual({ from_owner_user_id: null, to_owner_user_id: A });
  });

  it('maps score_changed and drops the score from other types', () => {
    expect(
      activityDataForContract('score_changed', { from_band: 'C', to_band: 'B', score: 55 }),
    ).toEqual({ from_band: 'C', to_band: 'B', to_score: 55 });
    expect(
      activityDataForContract('submission_received', {
        submission_id: A,
        score: 80,
        score_band: 'A',
        submissions_count: 2,
      }),
    ).toEqual({ submission_id: A });
  });

  it('keeps a note body and drops it when oversized or not text', () => {
    expect(activityDataForContract('note_added', { body: 'ligar amanhã' })).toEqual({
      body: 'ligar amanhã',
    });
    expect(activityDataForContract('note_added', { body: 'x'.repeat(5001) })).toEqual({});
    expect(activityDataForContract('note_added', { body: 42 })).toEqual({});
  });

  it('drops unknown keys, wrong types and values outside the closed vocabularies', () => {
    expect(
      activityDataForContract('stage_changed', {
        from: 'archived',
        to: 'won',
        email: 'leak@example.com',
        extra: { nested: true },
      }),
    ).toEqual({ to_stage: 'won' });
    expect(activityDataForContract('conversion_sent', { destination: 'tiktok' })).toEqual({});
    expect(activityDataForContract('owner_assigned', { owner_id: 'not-a-uuid' })).toEqual({});
    expect(activityDataForContract('score_changed', { score: 101 })).toEqual({});
  });

  it('copes with a non-object payload and with types that carry no data', () => {
    expect(activityDataForContract('anonymized', { anything: 1 })).toEqual({});
    expect(activityDataForContract('insight_generated', null)).toEqual({});
    expect(activityDataForContract('insight_generated', { insight_id: B.toUpperCase() })).toEqual({
      insight_id: B,
    });
  });
});

describe('escapeLikePattern', () => {
  it.each([
    ['plain', 'plain'],
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['%_\\', '\\%\\_\\\\'],
  ])('escapes %j as %j', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });
});
