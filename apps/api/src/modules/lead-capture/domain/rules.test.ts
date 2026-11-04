import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_PATTERN,
  TEXT_RULES,
  satisfiesE164Rule,
  satisfiesEmailRule,
  satisfiesTextRule,
} from '#/modules/lead-capture/domain/rules.ts';

describe('satisfiesTextRule (AC-LC-13 oracle)', () => {
  it.each([
    ['not NFC', 'Jose\u0301'],
    ['edge whitespace', ' Maria'],
    ['double space', 'Maria  Silva'],
    ['non-breaking space', 'Maria\u00A0Silva'],
    ['zero-width character', 'Ma\u200Bria'],
    ['lone surrogate', 'Ma\ud800ria'],
    ['digit', 'Maria2'],
    ['bad structure', '-Maria'],
    ['too long', 'a'.repeat(61)],
    ['empty', ''],
  ])('rejects a value that is %s', (_label, value) => {
    expect(satisfiesTextRule(value, TEXT_RULES.firstName)).toBe(false);
  });

  it('accepts a normalized name', () => {
    expect(satisfiesTextRule("João D'Ávila-Souza", TEXT_RULES.firstName)).toBe(true);
  });

  it('allows line breaks only in multiline mode and caps their runs', () => {
    expect(satisfiesTextRule('a\nb', TEXT_RULES.message)).toBe(false);
    expect(satisfiesTextRule('a\nb', TEXT_RULES.message, true)).toBe(true);
    expect(satisfiesTextRule(`a${'\n'.repeat(11)}b`, TEXT_RULES.message, true)).toBe(false);
    expect(satisfiesTextRule('a\u0007b', TEXT_RULES.message, true)).toBe(false);
  });
});

describe('satisfiesEmailRule / satisfiesE164Rule', () => {
  it('rejects uppercase, over-long local parts and malformed addresses', () => {
    expect(satisfiesEmailRule('Maria@empresa.com')).toBe(false);
    expect(satisfiesEmailRule(`${'a'.repeat(65)}@empresa.com`)).toBe(false);
    expect(satisfiesEmailRule('maria@empresa')).toBe(false);
    expect(satisfiesEmailRule('maria@empresa.com')).toBe(true);
  });

  it('matches the database E.164 CHECK', () => {
    expect(satisfiesE164Rule('+5511912345678')).toBe(true);
    expect(satisfiesE164Rule('5511912345678')).toBe(false);
    expect(satisfiesE164Rule('+0511912345678')).toBe(false);
    expect(satisfiesE164Rule('+1234567')).toBe(false);
  });
});

describe('IDEMPOTENCY_KEY_PATTERN', () => {
  it('matches UUID v4 and v7 only', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('0f8c2c1e-7d0b-4b8e-9a51-2f3c4d5e6f70')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('01939a8e-4c3b-7a2e-8f10-3b2a1c0d9e8f')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(false);
  });
});
