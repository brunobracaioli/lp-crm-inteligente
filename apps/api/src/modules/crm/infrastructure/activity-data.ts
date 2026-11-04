import type { ActivityDataValue } from '#/modules/crm/application/queries/ports.ts';
import {
  LEAD_STAGES,
  LOST_REASONS,
  type LeadActivityType,
} from '#/modules/crm/domain/lead-types.ts';

/**
 * Maps the stored `crm.lead_activities.data` (written by several producers over time) to the
 * contract's `ActivityData`, which is `additionalProperties: false`. It reads defensively:
 * both the key names the domain events write today (`from`, `to`, `previous_owner_id`, `owner_id`,
 * `score`) and the contract's names (`from_stage`, `to_stage`, `from_owner_user_id`, ...) are
 * accepted; values are checked against the closed vocabularies; anything unknown is dropped, so a new
 * producer key can never leak into a response or break its schema.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCORE_BANDS: readonly string[] = ['A', 'B', 'C'];
const CONVERSION_DESTINATIONS: readonly string[] = ['meta_capi', 'ga4_mp', 'google_ads'];
const MAX_SCORE = 100;
/** Contract `ActivityData.body` maxLength. */
const MAX_NOTE_BODY_LENGTH = 5000;

type Raw = Readonly<Record<string, unknown>>;
type Mutable = Record<string, ActivityDataValue>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function first(raw: Raw, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

function uuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
}

function oneOf(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

function score(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SCORE
    ? value
    : undefined;
}

/** A nullable UUID: `null` (no owner) is a value, absence is not. */
function nullableUuid(value: unknown): string | null | undefined {
  return value === null ? null : uuid(value);
}

function assign(target: Mutable, key: string, value: ActivityDataValue | undefined): void {
  if (value !== undefined) target[key] = value;
}

export function activityDataForContract(
  type: LeadActivityType,
  stored: unknown,
): Readonly<Record<string, ActivityDataValue>> {
  const raw: Raw = isRecord(stored) ? stored : {};
  const data: Mutable = {};
  switch (type) {
    case 'submission_received':
      assign(data, 'submission_id', uuid(raw.submission_id));
      break;
    case 'stage_changed':
      assign(data, 'from_stage', oneOf(first(raw, 'from_stage', 'from'), LEAD_STAGES));
      assign(data, 'to_stage', oneOf(first(raw, 'to_stage', 'to'), LEAD_STAGES));
      assign(data, 'lost_reason', oneOf(raw.lost_reason, LOST_REASONS));
      break;
    case 'owner_assigned':
      assign(
        data,
        'from_owner_user_id',
        nullableUuid(first(raw, 'from_owner_user_id', 'previous_owner_id')),
      );
      assign(data, 'to_owner_user_id', nullableUuid(first(raw, 'to_owner_user_id', 'owner_id')));
      break;
    case 'note_added':
      if (typeof raw.body === 'string' && raw.body.length <= MAX_NOTE_BODY_LENGTH) {
        data.body = raw.body;
      }
      break;
    case 'score_changed':
      assign(data, 'from_score', score(raw.from_score));
      assign(data, 'to_score', score(first(raw, 'to_score', 'score')));
      assign(data, 'from_band', oneOf(raw.from_band, SCORE_BANDS));
      assign(data, 'to_band', oneOf(raw.to_band, SCORE_BANDS));
      break;
    case 'conversion_sent':
      assign(data, 'destination', oneOf(raw.destination, CONVERSION_DESTINATIONS));
      break;
    case 'insight_generated':
      assign(data, 'insight_id', uuid(raw.insight_id));
      break;
    case 'anonymized':
      break;
  }
  return data;
}
