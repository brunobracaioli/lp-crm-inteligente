import { describe, expect, it } from 'vitest';
import {
  CompanyProfile,
  Email,
  PersonName,
  PhoneE164,
  type CompanyProfileInput,
} from '#/modules/crm/domain/value-objects.ts';

const VALID_COMPANY: CompanyProfileInput = {
  name: 'Empresa Ltda',
  area: 'technology',
  areaOther: null,
  size: '11_50',
  website: 'https://empresa.com.br',
  jobTitle: 'Head de Marketing',
};

describe('Email', () => {
  it('accepts a lowercase address', () => {
    expect(Email.parse('maria@empresa.com.br')).toEqual({
      ok: true,
      value: 'maria@empresa.com.br',
    });
  });

  it.each([
    ['uppercase', 'Maria@empresa.com.br'],
    ['no domain dot', 'maria@empresa'],
    ['inner space', 'maria silva@empresa.com'],
    ['two at signs', 'a@b@empresa.com'],
    ['too long', `${'a'.repeat(250)}@b.co`],
    ['empty', ''],
  ])('rejects %s', (_label, raw) => {
    expect(Email.parse(raw)).toEqual({ ok: false, error: { code: 'invalid_email' } });
  });
});

describe('PhoneE164', () => {
  it('accepts E.164 and rejects everything else', () => {
    expect(PhoneE164.parse('+5511912345678').ok).toBe(true);
    for (const raw of ['5511912345678', '+0511912345678', '+55 11 91234-5678', '+123', '']) {
      expect(PhoneE164.parse(raw)).toEqual({ ok: false, error: { code: 'invalid_whatsapp' } });
    }
  });
});

describe('PersonName', () => {
  it('accepts bounded, trimmed names', () => {
    expect(PersonName.parse('Maria', 'Silva')).toEqual({
      ok: true,
      value: { first: 'Maria', last: 'Silva' },
    });
  });

  it.each([
    ['empty first name', '', 'Silva'],
    ['empty last name', 'Maria', ''],
    ['untrimmed', ' Maria', 'Silva'],
    ['first name over 60', 'a'.repeat(61), 'Silva'],
    ['last name over 80', 'Maria', 'a'.repeat(81)],
  ])('rejects %s', (_label, first, last) => {
    expect(PersonName.parse(first, last)).toEqual({
      ok: false,
      error: { code: 'invalid_person_name' },
    });
  });
});

describe('CompanyProfile', () => {
  it('accepts a complete profile', () => {
    expect(CompanyProfile.parse(VALID_COMPANY)).toEqual({
      ok: true,
      value: {
        name: 'Empresa Ltda',
        area: 'technology',
        areaOther: null,
        size: '11_50',
        website: 'https://empresa.com.br',
        jobTitle: 'Head de Marketing',
      },
    });
  });

  it('accepts a minimal profile and an "other" area with its description', () => {
    expect(
      CompanyProfile.parse({
        name: 'Ab',
        area: 'other',
        areaOther: 'Gestao de frotas',
        size: null,
        website: null,
        jobTitle: null,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['unknown area', { area: 'astrology' }],
    ['unknown size', { size: 'huge' }],
    ['name too short', { name: 'A' }],
    ['name over 120', { name: 'a'.repeat(121) }],
    ['other area without description', { area: 'other', areaOther: null }],
    ['description with a non-other area', { areaOther: 'Gestao de frotas' }],
    ['description too short', { area: 'other', areaOther: 'G' }],
    ['job title too short', { jobTitle: 'x' }],
    ['website without scheme', { website: 'empresa.com.br' }],
    ['website over 200', { website: `https://e.com/${'a'.repeat(200)}` }],
    ['untrimmed name', { name: ' Empresa' }],
  ])('rejects %s', (_label, override) => {
    expect(CompanyProfile.parse({ ...VALID_COMPANY, ...override })).toEqual({
      ok: false,
      error: { code: 'invalid_company_profile' },
    });
  });
});
