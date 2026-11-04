import { describe, expect, it } from 'vitest';
import { hostnamesOfOrigins, isOriginAllowed } from '#/modules/lead-capture/domain/origin.ts';

const ALLOWED = ['https://www.dominio.com.br', 'https://localhost:5173'];

describe('isOriginAllowed', () => {
  it('accepts only an exact match of a listed origin', () => {
    expect(isOriginAllowed('https://www.dominio.com.br', ALLOWED)).toBe(true);
    expect(isOriginAllowed('https://localhost:5173', ALLOWED)).toBe(true);
  });

  it.each([
    ['missing Origin', null],
    ['empty Origin', ''],
    ['other host', 'https://evil.example'],
    ['sibling subdomain', 'https://app.dominio.com.br'],
    ['downgraded scheme', 'http://www.dominio.com.br'],
    ['other port', 'https://localhost:3000'],
    ['trailing slash', 'https://www.dominio.com.br/'],
    ['different case', 'https://WWW.dominio.com.br'],
  ])('rejects %s', (_label, origin) => {
    expect(isOriginAllowed(origin, ALLOWED)).toBe(false);
  });
});

describe('hostnamesOfOrigins', () => {
  it('derives unique hostnames without ports and skips unparsable entries', () => {
    expect(
      hostnamesOfOrigins([...ALLOWED, 'https://www.dominio.com.br:8443', 'not-an-origin']),
    ).toEqual(['www.dominio.com.br', 'localhost']);
  });
});
