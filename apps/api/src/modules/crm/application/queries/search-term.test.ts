import { describe, expect, it } from 'vitest';
import { parseSearchTerm } from './search-term.ts';

describe('parseSearchTerm', () => {
  it('trims, applies NFC and collapses inner spaces', () => {
    const decomposed = 'José    Silva';

    const result = parseSearchTerm(`  ${decomposed} `);

    expect(result).toEqual({ ok: true, value: 'José Silva' });
  });

  it('keeps LIKE wildcards as ordinary characters', () => {
    expect(parseSearchTerm('100%_\\x')).toEqual({ ok: true, value: '100%_\\x' });
  });

  it.each(['', ' ', 'a', ' a '])('rejects %j as too short', (raw) => {
    expect(parseSearchTerm(raw)).toEqual({ ok: false, error: 'too_short' });
  });

  it('counts code points, not UTF-16 units', () => {
    expect(parseSearchTerm('\u{1d54f}')).toEqual({ ok: false, error: 'too_short' });
    expect(parseSearchTerm('\u{1d54f}\u{1d54f}').ok).toBe(true);
    expect(parseSearchTerm('\u{1d54f}'.repeat(80)).ok).toBe(true);
    expect(parseSearchTerm('\u{1d54f}'.repeat(81))).toEqual({ ok: false, error: 'too_long' });
  });

  it.each([
    ['control character', 'ab\u0007cd'],
    ['line break', 'ab\ncd'],
    ['zero-width space', 'ab​cd'],
    ['bidi override', 'ab‮cd'],
    ['line separator', 'ab cd'],
    ['replacement character', 'ab�cd'],
    ['lone surrogate', 'ab\ud800cd'],
  ])('rejects a %s', (_name, raw) => {
    expect(parseSearchTerm(raw)).toEqual({ ok: false, error: 'not_allowed_characters' });
  });
});
