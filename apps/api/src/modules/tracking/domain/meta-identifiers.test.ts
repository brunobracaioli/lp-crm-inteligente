import { describe, expect, it } from 'vitest';
import { resolveFbc, resolveFbp } from '#/modules/tracking/domain/meta-identifiers.ts';

const CREATED_AT = new Date('2026-11-03T12:00:00.123Z');
const CREATED_AT_MS = CREATED_AT.getTime();

describe('resolveFbc', () => {
  it('assembles fb.1.<created_at_ms>.<fbclid> when only the click id is present', () => {
    expect(resolveFbc({ fbc: null, fbclid: 'IwAR0AbC-d_E', observedAt: CREATED_AT })).toBe(
      `fb.1.${CREATED_AT_MS}.IwAR0AbC-d_E`,
    );
  });

  it('keeps the fbclid case untouched', () => {
    const fbc = resolveFbc({ fbc: null, fbclid: 'AbCdEf', observedAt: CREATED_AT });
    expect(fbc?.endsWith('.AbCdEf')).toBe(true);
  });

  it('prefers a well-formed _fbc cookie value over assembling one', () => {
    const cookie = 'fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
    expect(resolveFbc({ fbc: cookie, fbclid: 'other', observedAt: CREATED_AT })).toBe(cookie);
  });

  it('falls back to the fbclid when the cookie value is malformed', () => {
    expect(resolveFbc({ fbc: 'garbage', fbclid: 'IwAR1', observedAt: CREATED_AT })).toBe(
      `fb.1.${CREATED_AT_MS}.IwAR1`,
    );
  });

  it.each([null, '', '   '])('returns null without a usable fbclid (%j)', (fbclid) => {
    expect(resolveFbc({ fbc: null, fbclid, observedAt: CREATED_AT })).toBeNull();
  });

  it('returns null for an fbclid that would break the cookie format', () => {
    expect(resolveFbc({ fbc: null, fbclid: 'a b"c', observedAt: CREATED_AT })).toBeNull();
    expect(resolveFbc({ fbc: null, fbclid: 'x'.repeat(600), observedAt: CREATED_AT })).toBeNull();
  });

  it('returns null for an invalid observation time', () => {
    expect(resolveFbc({ fbc: null, fbclid: 'IwAR1', observedAt: new Date(Number.NaN) })).toBeNull();
  });
});

describe('resolveFbp', () => {
  it('passes a Meta-documented _fbp value through', () => {
    expect(resolveFbp('fb.1.1596403881668.1116446470')).toBe('fb.1.1596403881668.1116446470');
  });

  it.each([null, '', 'fb.1.123.456', 'fb.1.1596403881668.<script>'])('drops %j', (value) => {
    expect(resolveFbp(value)).toBeNull();
  });
});
