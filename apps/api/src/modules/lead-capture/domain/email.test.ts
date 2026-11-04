import { describe, expect, it } from 'vitest';
import { isDisposableEmailDomain } from '#/modules/lead-capture/domain/disposable-domains.ts';
import { parseEmail } from '#/modules/lead-capture/domain/email.ts';

describe('parseEmail', () => {
  it('trims and lowercases a valid address', () => {
    expect(parseEmail('  Maria.Silva+Crm@Empresa.COM.br ')).toEqual({
      ok: true,
      value: 'maria.silva+crm@empresa.com.br',
    });
  });

  it('accepts webmail providers (Q3: only the score is reduced)', () => {
    expect(parseEmail('maria@gmail.com').ok).toBe(true);
  });

  it.each([
    ['no at sign', 'maria.empresa.com'],
    ['no TLD', 'maria@empresa'],
    ['one letter TLD', 'maria@empresa.c'],
    ['numeric TLD', 'maria@empresa.123'],
    ['quoted local part', '"maria silva"@empresa.com'],
    ['IP literal', 'maria@[192.168.0.1]'],
    ['leading dot', '.maria@empresa.com'],
    ['consecutive dots', 'ma..ria@empresa.com'],
    ['leading hyphen label', 'maria@-empresa.com'],
    ['non ASCII local part', 'mariá@empresa.com'],
    ['non ASCII domain', 'maria@empresá.com'],
    ['two at signs', 'a@b@empresa.com'],
    ['inner space', 'maria silva@empresa.com'],
  ])('rejects %s with invalid_format', (_label, value) => {
    expect(parseEmail(value)).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('rejects zero-width characters with not_allowed_characters', () => {
    expect(parseEmail('maria\u200B@empresa.com')).toEqual({
      ok: false,
      error: 'not_allowed_characters',
    });
  });

  it('rejects non-strings and blank values', () => {
    expect(parseEmail(7)).toEqual({ ok: false, error: 'invalid_format' });
    expect(parseEmail('  ')).toEqual({ ok: false, error: 'required' });
  });

  it('enforces 254 total characters and 64 for the local part', () => {
    // arrange
    const totalOver = `${'a'.repeat(250)}@b.co`;
    const localAtLimit = `${'a'.repeat(64)}@empresa.com`;
    const localOver = `${'a'.repeat(65)}@empresa.com`;
    // act / assert
    expect(totalOver).toHaveLength(255);
    expect(parseEmail(totalOver)).toEqual({ ok: false, error: 'too_long' });
    expect(parseEmail(localAtLimit).ok).toBe(true);
    expect(parseEmail(localOver)).toEqual({ ok: false, error: 'too_long' });
  });

  it('rejects disposable domains and their subdomains with invalid_choice', () => {
    expect(parseEmail('x@mailinator.com')).toEqual({ ok: false, error: 'invalid_choice' });
    expect(parseEmail('x@inbox.YOPMAIL.com')).toEqual({ ok: false, error: 'invalid_choice' });
  });
});

describe('isDisposableEmailDomain', () => {
  it('does not match a domain that merely ends with the same letters', () => {
    expect(isDisposableEmailDomain('notmailinator.com')).toBe(false);
    expect(isDisposableEmailDomain('com')).toBe(false);
  });
});
