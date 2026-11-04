import { describe, expect, it } from 'vitest';
import {
  EMPTY_ATTRIBUTION,
  hasPaidClickId,
  hasPaidOrigin,
  recordTouch,
  startAttribution,
} from '#/modules/crm/domain/attribution.ts';

const META_TOUCH = { ...EMPTY_ATTRIBUTION, utmSource: 'meta', fbclid: 'IwAR123' };
const DIRECT_TOUCH = { ...EMPTY_ATTRIBUTION, utmSource: 'newsletter' };
const GOOGLE_TOUCH = { ...EMPTY_ATTRIBUTION, utmSource: 'google', gclid: 'Cj0KCQ' };

describe('attribution', () => {
  it('starts with the same touch as first and last', () => {
    expect(startAttribution(META_TOUCH)).toEqual({ firstTouch: META_TOUCH, lastTouch: META_TOUCH });
  });

  it('AC-CRM-05: recording a touch preserves first_touch and replaces last_touch', () => {
    // arrange
    const initial = startAttribution(META_TOUCH);
    // act
    const next = recordTouch(initial, GOOGLE_TOUCH);
    // assert
    expect(next.firstTouch).toBe(META_TOUCH);
    expect(next.lastTouch).toBe(GOOGLE_TOUCH);
    expect(initial.lastTouch).toBe(META_TOUCH);
  });

  it.each(['gclid', 'gbraid', 'wbraid', 'fbclid'] as const)('%s is a paid click id', (key) => {
    expect(hasPaidClickId({ ...EMPTY_ATTRIBUTION, [key]: 'abc' })).toBe(true);
  });

  it('ttclid, msclkid, UTMs and empty strings are not paid click ids', () => {
    expect(hasPaidClickId({ ...EMPTY_ATTRIBUTION, ttclid: 'abc', msclkid: 'abc' })).toBe(false);
    expect(hasPaidClickId(DIRECT_TOUCH)).toBe(false);
    expect(hasPaidClickId({ ...EMPTY_ATTRIBUTION, gclid: '' })).toBe(false);
  });

  it('paid origin looks at both the first and the latest touch', () => {
    expect(hasPaidOrigin({ firstTouch: META_TOUCH, lastTouch: DIRECT_TOUCH })).toBe(true);
    expect(hasPaidOrigin({ firstTouch: DIRECT_TOUCH, lastTouch: GOOGLE_TOUCH })).toBe(true);
    expect(hasPaidOrigin({ firstTouch: DIRECT_TOUCH, lastTouch: DIRECT_TOUCH })).toBe(false);
  });
});
