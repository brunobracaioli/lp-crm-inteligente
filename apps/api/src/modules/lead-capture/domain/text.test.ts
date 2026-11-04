import { describe, expect, it } from 'vitest';
import { TEXT_RULES } from '#/modules/lead-capture/domain/rules.ts';
import {
  codePointLength,
  normalizeText,
  readText,
  truncateCodePoints,
} from '#/modules/lead-capture/domain/text.ts';

describe('normalizeText (Unicode pipeline)', () => {
  it('trims, applies NFC and collapses inner space separators', () => {
    // arrange
    const decomposed = '  Jose\u0301\u00A0\u00A0 da   Silva  ';
    // act
    const result = normalizeText(decomposed);
    // assert
    expect(result).toEqual({ ok: true, value: 'José da Silva' });
  });

  it.each([
    ['zero-width space', 'Ma\u200Bria'],
    ['zero-width joiner', 'Ma\u200Dria'],
    ['inner BOM', 'Ma\uFEFFria'],
    ['right-to-left override (Trojan Source)', 'Maria\u202Eaha'],
    ['isolate control', 'Maria\u2066x'],
    ['NUL control', 'Ma\u0000ria'],
    ['tab control', 'Ma\tria'],
    ['inner newline', 'Ma\nria'],
    ['replacement character', 'Ma\uFFFDria'],
    ['lone high surrogate', 'Ma\ud800ria'],
    ['line separator', 'Ma\u2028ria'],
  ])('rejects %s with not_allowed_characters', (_label, value) => {
    expect(normalizeText(value)).toEqual({ ok: false, error: 'not_allowed_characters' });
  });

  it('keeps line breaks only in multiline mode, normalizing CRLF and capping runs at 10', () => {
    // arrange
    const raw = `line one\r\nline two\r${'\n'.repeat(15)}end`;
    // act
    const result = normalizeText(raw, true);
    // assert
    expect(result).toEqual({
      ok: true,
      value: `line one\nline two${'\n'.repeat(10)}end`,
    });
  });

  it('still rejects other control characters in multiline mode', () => {
    expect(normalizeText('a\u0007b', true)).toEqual({ ok: false, error: 'not_allowed_characters' });
  });

  it('does not collapse inner spaces in multiline mode', () => {
    expect(normalizeText('a   b', true)).toEqual({ ok: true, value: 'a   b' });
  });
});

describe('readText', () => {
  it('rejects non-string values with invalid_format', () => {
    expect(readText(42, TEXT_RULES.firstName)).toEqual({ ok: false, error: 'invalid_format' });
    expect(readText({}, TEXT_RULES.firstName)).toEqual({ ok: false, error: 'invalid_format' });
    expect(readText(['a'], TEXT_RULES.firstName)).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('reports an empty value as required', () => {
    expect(readText('   ', TEXT_RULES.firstName)).toEqual({ ok: false, error: 'required' });
  });

  it('measures length in code points after normalization', () => {
    // arrange: 60 letters, then 61
    const atLimit = 'a'.repeat(60);
    // act / assert
    expect(readText(atLimit, TEXT_RULES.firstName).ok).toBe(true);
    expect(readText(`${atLimit}a`, TEXT_RULES.firstName)).toEqual({ ok: false, error: 'too_long' });
    expect(readText('a', TEXT_RULES.company)).toEqual({ ok: false, error: 'too_short' });
  });

  it('reports characters outside the whitelist as not_allowed_characters and bad structure as invalid_format', () => {
    expect(readText('Maria 2', TEXT_RULES.firstName)).toEqual({
      ok: false,
      error: 'not_allowed_characters',
    });
    expect(readText('<script>', TEXT_RULES.firstName)).toEqual({
      ok: false,
      error: 'not_allowed_characters',
    });
    expect(readText('😀', TEXT_RULES.firstName)).toEqual({
      ok: false,
      error: 'not_allowed_characters',
    });
    expect(readText('-Maria', TEXT_RULES.firstName)).toEqual({
      ok: false,
      error: 'invalid_format',
    });
  });

  it("accepts accents, apostrophes, hyphens and dots (João D'Ávila-Souza Jr.)", () => {
    expect(readText("João D'Ávila-Souza Jr.", TEXT_RULES.firstName)).toEqual({
      ok: true,
      value: "João D'Ávila-Souza Jr.",
    });
  });
});

describe('code point helpers', () => {
  it('counts an astral character as one code point', () => {
    expect(codePointLength('a😀b')).toBe(3);
  });

  it('truncates without splitting a surrogate pair', () => {
    expect(truncateCodePoints('a😀b', 2)).toBe('a😀');
  });
});
