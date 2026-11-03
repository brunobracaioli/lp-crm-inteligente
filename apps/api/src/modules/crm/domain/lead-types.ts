/**
 * Frozen vocabulary of the Lead aggregate (crm §4–5, database §3.3/3.6), created in Onda 0 so the
 * ports compile before the domain exists. Onda 2 adds behaviour around these types; changing a
 * union is a contract change (migration + PR of its own).
 */
export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LOST_REASONS = [
  'no_budget',
  'no_fit',
  'no_response',
  'chose_competitor',
  'timing',
  'invalid_contact',
  'duplicate',
  'other',
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export type ScoreBand = 'A' | 'B' | 'C';

export interface ScoreContribution {
  readonly ruleId: string;
  readonly points: number;
}

export const LEAD_ACTIVITY_TYPES = [
  'submission_received',
  'stage_changed',
  'owner_assigned',
  'note_added',
  'score_changed',
  'insight_generated',
  'conversion_sent',
  'anonymized',
] as const;
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];

export type ActorType = 'system' | 'user' | 'ai';
