import { describe, expect, it } from 'vitest';
import { createKeyedMac, deriveKey } from './derived-key.ts';

const PEPPER = Buffer.alloc(32, 7).toString('base64');

describe('deriveKey', () => {
  it('is deterministic per label and differs across labels', () => {
    expect(deriveKey(PEPPER, 'crm-cursor-v1')).toEqual(deriveKey(PEPPER, 'crm-cursor-v1'));
    expect(deriveKey(PEPPER, 'crm-cursor-v1')).not.toEqual(deriveKey(PEPPER, 'crm-plan-v1'));
  });

  it('differs from the raw pepper and has 32 bytes', () => {
    const key = deriveKey(PEPPER, 'crm-plan-v1');
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(PEPPER, 'base64'))).toBe(false);
  });

  it('rejects an empty pepper', () => {
    expect(() => deriveKey('', 'crm-cursor-v1')).toThrow(TypeError);
  });
});

describe('createKeyedMac', () => {
  it('produces label-bound, url-safe MACs', () => {
    const cursor = createKeyedMac(PEPPER, 'crm-cursor-v1');
    const plan = createKeyedMac(PEPPER, 'crm-plan-v1');
    expect(cursor('x')).toBe(cursor('x'));
    expect(cursor('x')).not.toBe(plan('x'));
    expect(cursor('x')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
