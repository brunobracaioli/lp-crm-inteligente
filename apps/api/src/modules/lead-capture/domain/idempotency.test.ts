import { describe, expect, it } from 'vitest';
import {
  canonicalizeForIdempotency,
  parseIdempotencyKey,
} from '#/modules/lead-capture/domain/idempotency.ts';
import {
  parseSubmission,
  type SubmissionSnapshot,
} from '#/modules/lead-capture/domain/submission.ts';

const OPTIONS = { allowedOrigins: ['https://www.dominio.com.br'] };

function snapshotOf(body: Record<string, unknown>): SubmissionSnapshot {
  const result = parseSubmission(body, OPTIONS);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value.snapshot;
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    form_key: 'frm_lp_principal',
    turnstile_token: 'token-1',
    first_name: 'Maria',
    last_name: 'Silva',
    email: 'maria@empresa.com.br',
    whatsapp: '11912345678',
    company: 'Empresa Ltda',
    area_of_expertise: 'technology',
    privacy_consent: true,
    tracking: { utm_source: 'meta' },
    ...overrides,
  };
}

describe('parseIdempotencyKey', () => {
  it('accepts UUID v4 and v7 and lowercases them', () => {
    expect(parseIdempotencyKey('0F8C2C1E-7D0B-4B8E-9A51-2F3C4D5E6F70')).toEqual({
      ok: true,
      value: '0f8c2c1e-7d0b-4b8e-9a51-2f3c4d5e6f70',
    });
    expect(parseIdempotencyKey('01939a8e-4c3b-7a2e-8f10-3b2a1c0d9e8f').ok).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['not a UUID', 'abc'],
    ['UUID v1', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
    ['UUID v4 with a bad variant', '0f8c2c1e-7d0b-4b8e-1a51-2f3c4d5e6f70'],
    ['trailing garbage', '0f8c2c1e-7d0b-4b8e-9a51-2f3c4d5e6f70x'],
  ])('rejects %s as idempotency_key_missing', (_label, header) => {
    expect(parseIdempotencyKey(header)).toEqual({ ok: false, error: 'idempotency_key_missing' });
  });
});

describe('canonicalizeForIdempotency', () => {
  it('R7: ignores the Turnstile token, key order and normalization-only differences', () => {
    // arrange: a retry reuses the intent with a fresh token, other key order and sloppy spacing
    const first = snapshotOf(baseBody());
    const retry = snapshotOf({
      tracking: { utm_source: 'meta' },
      privacy_consent: true,
      email: '  MARIA@empresa.com.br ',
      company: 'Empresa   Ltda',
      first_name: ' Maria ',
      last_name: 'Silva',
      area_of_expertise: 'technology',
      whatsapp: '+55 (11) 91234-5678',
      form_key: 'frm_lp_principal',
      turnstile_token: 'a-completely-different-token',
    });
    // act / assert
    expect(canonicalizeForIdempotency(retry)).toBe(canonicalizeForIdempotency(first));
  });

  it.each([
    ['first name', { first_name: 'Mariana' }],
    ['e-mail', { email: 'outra@empresa.com.br' }],
    ['marketing opt-in', { marketing_opt_in: true }],
    ['message', { message: 'olá' }],
    ['consent', { consent: { ad_user_data: 'granted' } }],
    ['tracking', { tracking: { utm_source: 'google' } }],
    [
      'client event id',
      { tracking: { utm_source: 'meta', event_id: '0f8c2c1e-7d0b-4b8e-9a51-2f3c4d5e6f70' } },
    ],
    ['form', { form_key: 'frm_outro' }],
  ])('R7: a different %s changes the canonical payload', (_label, overrides) => {
    // arrange
    const original = snapshotOf(baseBody());
    const changed = snapshotOf(baseBody(overrides));
    // act / assert
    expect(canonicalizeForIdempotency(changed)).not.toBe(canonicalizeForIdempotency(original));
  });

  it('does not contain the Turnstile token or any server-generated value', () => {
    // arrange
    const payload = canonicalizeForIdempotency(snapshotOf(baseBody()));
    // assert
    expect(payload).not.toContain('token-1');
    expect(JSON.parse(payload)).toMatchObject({ tracking: { event_id: null } });
  });
});
