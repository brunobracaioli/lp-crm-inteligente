import { describe, expect, it } from 'vitest';
import { timingSafeEqualText } from '#/platform/crypto/safe-compare.ts';

describe('timingSafeEqualText', () => {
  it('accepts identical values', () => {
    expect(timingSafeEqualText('abc_DEF-123', 'abc_DEF-123')).toBe(true);
  });

  it.each([
    ['a different value of the same length', 'abc', 'abd'],
    ['a prefix', 'abc', 'ab'],
    ['a longer value', 'abc', 'abcd'],
    ['an empty value', 'abc', ''],
  ])('rejects %s', (_label, a, b) => {
    expect(timingSafeEqualText(a, b)).toBe(false);
  });
});
