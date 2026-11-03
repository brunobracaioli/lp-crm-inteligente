import { describe, expect, it } from 'vitest';
import { createHmacHasher, sha256Hex, timingSafeEqualHex } from '#/platform/crypto/hashing.ts';

const PEPPER = Buffer.alloc(32, 7).toString('base64');

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('createHmacHasher', () => {
  it('produces a stable 64-char hex digest that does not contain the input', () => {
    // arrange
    const hash = createHmacHasher(PEPPER);
    // act
    const digest = hash('203.0.113.7');
    // assert
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(hash('203.0.113.7'));
    expect(digest).not.toContain('203.0.113.7');
  });

  it('gives different digests for different peppers', () => {
    const other = createHmacHasher(Buffer.alloc(32, 8).toString('base64'));
    expect(createHmacHasher(PEPPER)('x')).not.toBe(other('x'));
  });

  it('rejects a pepper shorter than 32 bytes', () => {
    expect(() => createHmacHasher(Buffer.alloc(16).toString('base64'))).toThrow(/at least 32/);
  });
});

describe('timingSafeEqualHex', () => {
  it('compares equal and different hex strings', () => {
    expect(timingSafeEqualHex('ab01', 'ab01')).toBe(true);
    expect(timingSafeEqualHex('ab01', 'ab02')).toBe(false);
  });

  it('returns false for length mismatch or non-hex input', () => {
    expect(timingSafeEqualHex('ab', 'ab01')).toBe(false);
    expect(timingSafeEqualHex('zz', 'zz')).toBe(false);
  });
});
