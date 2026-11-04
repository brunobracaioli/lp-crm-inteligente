import { describe, expect, it } from 'vitest';
import { originOf, parseTrackingUrl, parseWebsite } from '#/modules/lead-capture/domain/url.ts';

describe('parseWebsite', () => {
  it.each([
    ['empresa.com.br', 'https://empresa.com.br'],
    ['Empresa.COM.br/', 'https://empresa.com.br'],
    ['http://Empresa.com.br/Sobre?x=1#topo', 'http://empresa.com.br/Sobre?x=1'],
    ['https://www.empresa.com.br/', 'https://www.empresa.com.br'],
    ['  https://empresa.com.br  ', 'https://empresa.com.br'],
    ['münchen.de', 'https://xn--mnchen-3ya.de'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(parseWebsite(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['javascript scheme', 'javascript:alert(1)'],
    ['ftp scheme', 'ftp://empresa.com.br'],
    ['data scheme', 'data:text/html,hi'],
    ['credentials', 'https://user:pass@empresa.com.br'],
    ['user only', 'https://user@empresa.com.br'],
    ['non default port', 'https://empresa.com.br:8443'],
    ['host with port and no scheme', 'empresa.com.br:8080'],
    ['IPv4 literal', 'http://192.168.0.1'],
    ['numeric IPv4 form', 'http://2130706433'],
    ['IPv6 literal', 'http://[::1]'],
    ['localhost', 'http://localhost'],
    ['single label host', 'http://intranet'],
    ['.local host', 'http://printer.local'],
    ['.internal host', 'http://api.internal'],
    ['.localhost host', 'http://app.localhost'],
    ['numeric TLD', 'http://empresa.123'],
    ['inner space', 'https://empresa .com.br'],
  ])('rejects %s with invalid_format', (_label, input) => {
    expect(parseWebsite(input)).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('rejects inputs over 200 characters', () => {
    expect(parseWebsite(`empresa.com.br/${'a'.repeat(200)}`)).toEqual({
      ok: false,
      error: 'too_long',
    });
  });

  it('rejects a normalized website that percent-encoding pushes over 200 characters', () => {
    // arrange: 90 non-ASCII letters (1 code point each) become 6 characters each in the path
    const input = `empresa.com.br/${'ã'.repeat(90)}`;
    // act / assert
    expect(parseWebsite(input)).toEqual({ ok: false, error: 'too_long' });
  });

  it('rejects non-strings, blank values and invisible characters', () => {
    expect(parseWebsite(12)).toEqual({ ok: false, error: 'invalid_format' });
    expect(parseWebsite(' ')).toEqual({ ok: false, error: 'required' });
    expect(parseWebsite('empresa\u200B.com.br')).toEqual({
      ok: false,
      error: 'not_allowed_characters',
    });
  });
});

describe('parseTrackingUrl', () => {
  it('keeps a valid absolute https URL, normalized by the URL parser', () => {
    expect(parseTrackingUrl('https://www.dominio.com.br/?utm_source=meta')).toEqual({
      ok: true,
      value: 'https://www.dominio.com.br/?utm_source=meta',
    });
  });

  it.each([
    ['relative URL', '/landing?x=1'],
    ['scheme-less host', 'www.dominio.com.br'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['credentials', 'https://a:b@dominio.com.br/'],
  ])('rejects %s with invalid_format', (_label, input) => {
    expect(parseTrackingUrl(input)).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('rejects URLs over 2000 characters', () => {
    expect(parseTrackingUrl(`https://dominio.com.br/?q=${'a'.repeat(2000)}`)).toEqual({
      ok: false,
      error: 'too_long',
    });
  });

  it('rejects non-strings and blank values', () => {
    expect(parseTrackingUrl(null)).toEqual({ ok: false, error: 'invalid_format' });
    expect(parseTrackingUrl('')).toEqual({ ok: false, error: 'required' });
  });
});

describe('originOf', () => {
  it('returns the origin of an absolute URL and null for garbage', () => {
    expect(originOf('https://www.dominio.com.br/a?b=1')).toBe('https://www.dominio.com.br');
    expect(originOf('not a url')).toBeNull();
  });
});
