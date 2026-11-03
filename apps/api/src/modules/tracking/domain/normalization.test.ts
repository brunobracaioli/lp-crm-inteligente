import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  normalizeIdentity,
  normalizeName,
  normalizePhone,
} from '#/modules/tracking/domain/normalization.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';

/**
 * Meta hashing test vectors.
 * Source: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 * Accessed: 2026-11-03. Every expected digest below was also recomputed locally with SHA-256 over
 * the normalized UTF-8 string, so a transcription error in this file cannot hide a regression.
 *
 * `external_id` has no documented vector (Meta defines no normalization), so it is only checked
 * for the project rule: trimmed, otherwise untouched.
 */
const META_VECTORS = {
  email: {
    input: 'John_Smith@gmail.com',
    normalized: 'john_smith@gmail.com',
    sha256: '62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f',
  },
  phone: {
    // Meta documents the US number "(650)555-1212" with country code 1 -> "16505551212".
    input: '+1 (650) 555-1212',
    normalized: '16505551212',
    sha256: 'e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176',
  },
  firstNameRoman: {
    input: 'Mary',
    normalized: 'mary',
    sha256: '6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec',
  },
  firstNameKorean: {
    input: '정',
    normalized: '정',
    sha256: '8fa8cd9c440be61d0151429310034083132b35975c4bea67fdd74158eb51db14',
  },
  firstNameAccented: {
    // Meta keeps special characters UTF-8 encoded: "Valéry" -> "valéry" (NOT "valery").
    input: 'Valéry',
    normalized: 'valéry',
    sha256: '08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c',
  },
} as const;

describe('Meta documented hashing vectors', () => {
  it('em: trim + lowercase, then SHA-256 matches the documented digest', () => {
    const { input, normalized, sha256 } = META_VECTORS.email;
    const result = normalizeEmail(`  ${input} `);
    expect(result).toEqual({ ok: true, value: normalized });
    expect(sha256Hex(normalized)).toBe(sha256);
  });

  it('ph: symbols stripped and country code kept, then SHA-256 matches the documented digest', () => {
    const { input, normalized, sha256 } = META_VECTORS.phone;
    const result = normalizePhone(input);
    expect(result).toEqual({ ok: true, value: normalized });
    expect(sha256Hex(normalized)).toBe(sha256);
  });

  it.each([
    ['roman', META_VECTORS.firstNameRoman],
    ['korean', META_VECTORS.firstNameKorean],
    ['accented', META_VECTORS.firstNameAccented],
  ] as const)('fn: %s name normalizes to the documented value and digest', (_label, vector) => {
    expect(normalizeName(vector.input)).toBe(vector.normalized);
    expect(sha256Hex(vector.normalized)).toBe(vector.sha256);
  });

  it('ln: uses the same rules as fn', () => {
    expect(normalizeName('VALÉRY')).toBe(META_VECTORS.firstNameAccented.normalized);
  });
});

describe('normalizeEmail', () => {
  it.each(['', 'no-at-sign', 'two@@signs.com', 'spa ce@x.com', '@x.com', 'a@'])(
    'rejects %j',
    (raw) => {
      expect(normalizeEmail(raw)).toEqual({ ok: false, error: 'invalid_email' });
    },
  );

  it('rejects an address longer than 254 characters', () => {
    expect(normalizeEmail(`${'a'.repeat(250)}@x.com`)).toEqual({
      ok: false,
      error: 'invalid_email',
    });
  });
});

describe('normalizePhone', () => {
  it('keeps only digits of an E.164 Brazilian mobile number', () => {
    expect(normalizePhone('+5511999998888')).toEqual({ ok: true, value: '5511999998888' });
  });

  it('removes letters and leading zeros', () => {
    expect(normalizePhone('00 (55) 11 99999-8888 ext')).toEqual({
      ok: true,
      value: '5511999998888',
    });
  });

  it.each(['', '+55', '123456', '1'.repeat(16), 'abc'])('rejects %j', (raw) => {
    expect(normalizePhone(raw)).toEqual({ ok: false, error: 'invalid_phone' });
  });
});

describe('normalizeName', () => {
  it('removes punctuation, keeps accents, collapses whitespace and lowercases', () => {
    expect(normalizeName("  D'Ávila-Silva,  JOÃO Jr. ")).toBe('dávilasilva joão jr');
  });

  it('returns an empty string when only punctuation is given', () => {
    expect(normalizeName(".-' ")).toBe('');
  });

  it('composes decomposed characters (NFD input hashes like NFC input)', () => {
    expect(normalizeName('Valéry')).toBe(META_VECTORS.firstNameAccented.normalized);
  });

  it('is idempotent and never leaves punctuation or uppercase letters', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (raw) => {
        const once = normalizeName(raw);
        expect(normalizeName(once)).toBe(once);
        expect(once).not.toMatch(/[\p{P}\p{S}]/u);
        expect(once).toBe(once.toLowerCase());
      }),
    );
  });
});

describe('normalizeIdentity', () => {
  const raw = {
    email: ' Maria.Souza@Empresa.com.br ',
    whatsappE164: '+5511987654321',
    firstName: 'Maria',
    lastName: 'Souza-Lima',
    externalId: ' 0192f3a0-aaaa-7bbb-8ccc-123456789abc ',
  };

  it('normalizes every identifier and trims the external id without changing its case', () => {
    expect(normalizeIdentity(raw)).toEqual({
      ok: true,
      value: {
        email: 'maria.souza@empresa.com.br',
        phone: '5511987654321',
        firstName: 'maria',
        lastName: 'souzalima',
        externalId: '0192f3a0-aaaa-7bbb-8ccc-123456789abc',
      },
    });
  });

  it.each([
    [{ email: 'nope' }, 'invalid_email'],
    [{ whatsappE164: '+1' }, 'invalid_phone'],
    [{ firstName: '...' }, 'empty_first_name'],
    [{ lastName: '-' }, 'empty_last_name'],
    [{ externalId: '  ' }, 'empty_external_id'],
  ] as const)(
    'fails with %j -> %s instead of hashing an empty or invalid value',
    (patch, error) => {
      expect(normalizeIdentity({ ...raw, ...patch })).toEqual({ ok: false, error });
    },
  );
});
