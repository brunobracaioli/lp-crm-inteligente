import { describe, expect, it } from 'vitest';
import { MAX_FIELD_ERRORS, type FieldError } from '#/modules/lead-capture/domain/field-error.ts';
import {
  parseEnvelope,
  parseSubmission,
  submissionFields,
  type SubmissionSnapshot,
} from '#/modules/lead-capture/domain/submission.ts';

const ALLOWED_ORIGINS = ['https://www.dominio.com.br'];
const OPTIONS = { allowedOrigins: ALLOWED_ORIGINS };
const EVENT_ID = '0f8c2c1e-7d0b-4b8e-9a51-2f3c4d5e6f70';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    form_key: 'frm_lp_principal',
    turnstile_token: '0.AbCd',
    first_name: 'Maria',
    last_name: 'Silva',
    email: 'Maria@Empresa.com.br',
    whatsapp: '+55 11 91234-5678',
    company: 'Empresa Ltda',
    area_of_expertise: 'technology',
    privacy_consent: true,
    ...overrides,
  };
}

function without(body: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== field));
}

function errorsOf(body: unknown): readonly FieldError[] {
  const result = parseSubmission(body, OPTIONS);
  if (result.ok) {
    throw new Error('expected validation errors');
  }
  return result.error;
}

function snapshotOf(body: unknown): SubmissionSnapshot {
  const result = parseSubmission(body, OPTIONS);
  if (!result.ok) {
    throw new Error(`expected a valid submission: ${JSON.stringify(result.error)}`);
  }
  return result.value.snapshot;
}

describe('parseSubmission: valid input', () => {
  it('normalizes a minimal payload and defaults every optional value', () => {
    // arrange
    const body = validBody();
    // act
    const snapshot = snapshotOf(body);
    // assert
    expect(snapshot).toMatchObject({
      formKey: 'frm_lp_principal',
      firstName: 'Maria',
      lastName: 'Silva',
      email: 'maria@empresa.com.br',
      whatsappE164: '+5511912345678',
      companyName: 'Empresa Ltda',
      areaOfExpertise: 'technology',
      areaOfExpertiseOther: null,
      jobTitle: null,
      companySize: null,
      companyWebsite: null,
      message: null,
      marketingOptIn: false,
      privacyConsent: true,
      eventId: null,
    });
    expect(snapshot.consent).toEqual({
      analyticsStorage: 'denied',
      adStorage: 'denied',
      adUserData: 'denied',
      adPersonalization: 'denied',
    });
    expect(Object.values(snapshot.attribution).every((value) => value === null)).toBe(true);
  });

  it('normalizes a complete payload (area other, website, message, consent, tracking)', () => {
    // arrange
    const body = validBody({
      area_of_expertise: 'other',
      area_of_expertise_other: '  Gestão   de frotas ',
      job_title: 'Head de Marketing',
      company_size: '11_50',
      company_website: 'Empresa.com.br',
      message: 'Quero integrar o CRM.\r\nObrigada',
      marketing_opt_in: true,
      hp: '',
      consent: { analytics_storage: 'granted', ad_user_data: 'granted' },
      tracking: {
        event_id: EVENT_ID.toUpperCase(),
        utm_source: 'meta',
        utm_campaign: 'lp-crm-q4',
        utm_term: null,
        gclid: 'Cj0KCQ_abc-123~x',
        fbp: 'fb.1.1730600000000.123456789',
        fbc: 'fb.1.1730600000000.IwAR-x',
        ga_client_id: '123456789.1730600000',
        landing_page_url: 'https://www.dominio.com.br/?utm_source=meta',
        referrer_url: 'https://l.facebook.com/',
      },
    });
    // act
    const snapshot = snapshotOf(body);
    // assert
    expect(snapshot.areaOfExpertiseOther).toBe('Gestão de frotas');
    expect(snapshot).toMatchObject({
      jobTitle: 'Head de Marketing',
      companySize: '11_50',
      companyWebsite: 'https://empresa.com.br',
      message: 'Quero integrar o CRM.\nObrigada',
      marketingOptIn: true,
      eventId: EVENT_ID,
    });
    expect(snapshot.consent).toEqual({
      analyticsStorage: 'granted',
      adStorage: 'denied',
      adUserData: 'granted',
      adPersonalization: 'denied',
    });
    expect(snapshot.attribution).toMatchObject({
      utmSource: 'meta',
      utmCampaign: 'lp-crm-q4',
      utmTerm: null,
      gclid: 'Cj0KCQ_abc-123~x',
      fbp: 'fb.1.1730600000000.123456789',
      gaClientId: '123456789.1730600000',
      landingPageUrl: 'https://www.dominio.com.br/?utm_source=meta',
      referrerUrl: 'https://l.facebook.com/',
    });
  });

  it('treats blank optional values as absent', () => {
    // arrange
    const body = validBody({
      job_title: '  ',
      company_size: '',
      company_website: '',
      message: ' \n ',
      area_of_expertise_other: '',
    });
    // act
    const snapshot = snapshotOf(body);
    // assert
    expect(snapshot).toMatchObject({
      jobTitle: null,
      companySize: null,
      companyWebsite: null,
      message: null,
      areaOfExpertiseOther: null,
    });
  });

  it('exposes the normalized form fields for capture.submissions.fields (no message, no token)', () => {
    // arrange
    const snapshot = snapshotOf(validBody({ marketing_opt_in: true }));
    // act
    const fields = submissionFields(snapshot);
    // assert
    expect(fields).toEqual({
      first_name: 'Maria',
      last_name: 'Silva',
      email: 'maria@empresa.com.br',
      whatsapp: '+5511912345678',
      company: 'Empresa Ltda',
      area_of_expertise: 'technology',
      area_of_expertise_other: null,
      job_title: null,
      company_size: null,
      company_website: null,
      marketing_opt_in: true,
      privacy_consent: true,
    });
  });
});

describe('parseSubmission: required fields', () => {
  it.each(['first_name', 'last_name', 'email', 'whatsapp', 'company', 'area_of_expertise'])(
    'AC-LC-02: missing %s yields errors[].field = %s and code = required',
    (field) => {
      // arrange
      const body = without(validBody(), field);
      // act
      const errors = errorsOf(body);
      // assert
      expect(errors).toEqual([{ field, code: 'required' }]);
    },
  );

  it.each(['first_name', 'last_name', 'email', 'whatsapp', 'company', 'area_of_expertise'])(
    'AC-LC-02: %s sent as null or blank is also required',
    (field) => {
      expect(errorsOf(validBody({ [field]: null }))).toEqual([{ field, code: 'required' }]);
      expect(errorsOf(validBody({ [field]: '   ' }))).toEqual([{ field, code: 'required' }]);
    },
  );

  it('AC-LC-02: reports every missing required field at once', () => {
    // arrange
    const body = { form_key: 'frm_lp_principal', turnstile_token: 'tok' };
    // act
    const errors = errorsOf(body);
    // assert
    expect(errors.map((error) => error.field)).toEqual([
      'first_name',
      'last_name',
      'email',
      'whatsapp',
      'company',
      'area_of_expertise',
      'privacy_consent',
    ]);
    expect(errors.every((error) => error.code === 'required')).toBe(true);
  });

  it('AC-LC-03: privacy_consent = false is must_be_true', () => {
    expect(errorsOf(validBody({ privacy_consent: false }))).toEqual([
      { field: 'privacy_consent', code: 'must_be_true' },
    ]);
  });

  it('AC-LC-03: privacy_consent absent is required and a string is invalid_format', () => {
    expect(errorsOf(without(validBody(), 'privacy_consent'))).toEqual([
      { field: 'privacy_consent', code: 'required' },
    ]);
    expect(errorsOf(validBody({ privacy_consent: 'true' }))).toEqual([
      { field: 'privacy_consent', code: 'invalid_format' },
    ]);
  });

  it('treats a non-object body as every required field missing', () => {
    expect(errorsOf([]).map((error) => error.code)).toContain('required');
    expect(errorsOf('text').length).toBeGreaterThan(0);
    expect(errorsOf(null).length).toBeGreaterThan(0);
  });
});

describe('parseSubmission: field rules', () => {
  it('rejects wrongly typed values with invalid_format', () => {
    expect(errorsOf(validBody({ first_name: 42 }))).toEqual([
      { field: 'first_name', code: 'invalid_format' },
    ]);
    expect(errorsOf(validBody({ email: ['a@b.co'] }))).toEqual([
      { field: 'email', code: 'invalid_format' },
    ]);
    expect(errorsOf(validBody({ marketing_opt_in: 'yes' }))).toEqual([
      { field: 'marketing_opt_in', code: 'invalid_format' },
    ]);
  });

  it('rejects an unknown enum code with invalid_choice', () => {
    expect(errorsOf(validBody({ area_of_expertise: 'astrology' }))).toEqual([
      { field: 'area_of_expertise', code: 'invalid_choice' },
    ]);
    expect(errorsOf(validBody({ company_size: '5000' }))).toEqual([
      { field: 'company_size', code: 'invalid_choice' },
    ]);
  });

  it('requires area_of_expertise_other when the area is other', () => {
    expect(errorsOf(validBody({ area_of_expertise: 'other' }))).toEqual([
      { field: 'area_of_expertise_other', code: 'required' },
    ]);
  });

  it('forbids area_of_expertise_other when the area is not other', () => {
    expect(errorsOf(validBody({ area_of_expertise_other: 'Gestão' }))).toEqual([
      { field: 'area_of_expertise_other', code: 'invalid_format' },
    ]);
  });

  it('does not double-report area_of_expertise_other when its own value is invalid', () => {
    expect(
      errorsOf(validBody({ area_of_expertise: 'other', area_of_expertise_other: '<b>' })),
    ).toEqual([{ field: 'area_of_expertise_other', code: 'not_allowed_characters' }]);
  });

  it('reports not_allowed_characters for emoji, digits and markup in names', () => {
    for (const value of ['Maria 😀', 'Maria2', '<script>alert(1)</script>', 'Ma\u202Eria']) {
      expect(errorsOf(validBody({ first_name: value }))).toEqual([
        { field: 'first_name', code: 'not_allowed_characters' },
      ]);
    }
  });

  it('keeps SQL and markup payloads in message literally', () => {
    // arrange
    const message = "'; DROP TABLE crm.leads; -- <script>alert(1)</script> ' OR 1=1--";
    // act
    const snapshot = snapshotOf(validBody({ message }));
    // assert
    expect(snapshot.message).toBe(message);
  });

  it('enforces the 1000 character message limit', () => {
    expect(snapshotOf(validBody({ message: 'a'.repeat(1000) })).message).toHaveLength(1000);
    expect(errorsOf(validBody({ message: 'a'.repeat(1001) }))).toEqual([
      { field: 'message', code: 'too_long' },
    ]);
  });

  it('rejects an invalid website and a disposable e-mail', () => {
    expect(errorsOf(validBody({ company_website: 'javascript:alert(1)' }))).toEqual([
      { field: 'company_website', code: 'invalid_format' },
    ]);
    expect(errorsOf(validBody({ email: 'x@mailinator.com' }))).toEqual([
      { field: 'email', code: 'invalid_choice' },
    ]);
  });

  it('rejects an invalid WhatsApp number', () => {
    expect(errorsOf(validBody({ whatsapp: '1191234567' }))).toEqual([
      { field: 'whatsapp', code: 'invalid_format' },
    ]);
  });
});

describe('parseSubmission: unknown fields (anti mass-assignment)', () => {
  it('AC-LC-11: an unknown top-level field is rejected with code not_allowed', () => {
    expect(errorsOf(validBody({ stage: 'won' }))).toEqual([
      { field: 'stage', code: 'not_allowed' },
    ]);
  });

  it('AC-LC-11: unknown fields inside consent and tracking are rejected with their path', () => {
    expect(errorsOf(validBody({ consent: { marketing: 'granted' } }))).toEqual([
      { field: 'consent.marketing', code: 'not_allowed' },
    ]);
    expect(errorsOf(validBody({ tracking: { score: 100 } }))).toEqual([
      { field: 'tracking.score', code: 'not_allowed' },
    ]);
  });

  it('AC-LC-11: reports several unknown fields and never reflects hostile key names', () => {
    // arrange
    const body = validBody({ owner: 'x', score: 100, '<img src=x>': 1, ['a'.repeat(100)]: 1 });
    // act
    const errors = errorsOf(body);
    // assert
    expect(errors).toEqual([
      { field: 'owner', code: 'not_allowed' },
      { field: 'score', code: 'not_allowed' },
      { field: '_unknown', code: 'not_allowed' },
      { field: '_unknown', code: 'not_allowed' },
    ]);
  });

  it('AC-LC-11: an own __proto__ key from JSON.parse is treated as an unknown field', () => {
    // arrange
    const body: unknown = JSON.parse('{"form_key":"frm_lp_principal","__proto__":{"stage":"won"}}');
    // act
    const errors = errorsOf(body);
    // assert
    expect(errors).toContainEqual({ field: '__proto__', code: 'not_allowed' });
  });

  it('caps the number of reported errors at 50', () => {
    // arrange
    const noise = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`extra_${String(i)}`, i]),
    );
    // act
    const errors = errorsOf(noise);
    // assert
    expect(errors).toHaveLength(MAX_FIELD_ERRORS);
  });
});

describe('parseSubmission: consent', () => {
  it('rejects an invalid consent value and a non-object consent', () => {
    expect(errorsOf(validBody({ consent: { ad_storage: 'maybe' } }))).toEqual([
      { field: 'consent.ad_storage', code: 'invalid_choice' },
    ]);
    expect(errorsOf(validBody({ consent: { ad_storage: true } }))).toEqual([
      { field: 'consent.ad_storage', code: 'invalid_format' },
    ]);
    expect(errorsOf(validBody({ consent: 'granted' }))).toEqual([
      { field: 'consent', code: 'invalid_format' },
    ]);
  });

  it('treats an absent or null consent object as everything denied', () => {
    expect(snapshotOf(validBody({ consent: null })).consent.adUserData).toBe('denied');
  });
});

describe('parseSubmission: tracking', () => {
  it('discards a landing page outside the form origins instead of rejecting it', () => {
    // arrange
    const body = validBody({
      tracking: {
        landing_page_url: 'https://evil.example/?utm_source=x',
        referrer_url: 'https://evil.example/',
      },
    });
    // act
    const snapshot = snapshotOf(body);
    // assert
    expect(snapshot.attribution.landingPageUrl).toBeNull();
    expect(snapshot.attribution.referrerUrl).toBe('https://evil.example/');
  });

  it('ignores a malformed event_id instead of rejecting the submission', () => {
    expect(snapshotOf(validBody({ tracking: { event_id: 'not-a-uuid' } })).eventId).toBeNull();
    expect(snapshotOf(validBody({ tracking: { event_id: 42 } })).eventId).toBeNull();
  });

  it('validates click ids, UTM characters, fbp and GA client id', () => {
    // arrange
    const body = validBody({
      tracking: {
        utm_source: 'me<ta>',
        gclid: 'abc def',
        fbp: 'fb.x.1.1',
        ga_client_id: 'abc',
        referrer_url: '/relative',
      },
    });
    // act
    const errors = errorsOf(body);
    // assert
    expect(errors).toEqual([
      { field: 'tracking.utm_source', code: 'not_allowed_characters' },
      { field: 'tracking.gclid', code: 'not_allowed_characters' },
      { field: 'tracking.fbp', code: 'invalid_format' },
      { field: 'tracking.ga_client_id', code: 'invalid_format' },
      { field: 'tracking.referrer_url', code: 'invalid_format' },
    ]);
  });

  it('rejects a non-object tracking value', () => {
    expect(errorsOf(validBody({ tracking: 'utm' }))).toEqual([
      { field: 'tracking', code: 'invalid_format' },
    ]);
  });
});

describe('parseSubmission: honeypot (R3)', () => {
  it('flags any non-empty hp without reporting an error about it', () => {
    for (const hp of ['x', ' ', 'a'.repeat(5000), 1, true, {}]) {
      const result = parseSubmission(validBody({ hp }), OPTIONS);
      expect(result.ok && result.value.honeypotFilled).toBe(true);
    }
  });

  it('does not flag an empty, null or absent hp', () => {
    for (const body of [validBody({ hp: '' }), validBody({ hp: null }), validBody()]) {
      const result = parseSubmission(body, OPTIONS);
      expect(result.ok && result.value.honeypotFilled).toBe(false);
    }
  });
});

describe('parseEnvelope (step 5)', () => {
  it('accepts a well-formed form_key and token without looking at other fields', () => {
    expect(
      parseEnvelope({ form_key: 'frm_lp_principal', turnstile_token: 'tok', stage: 'won' }),
    ).toEqual({
      ok: true,
      value: { formKey: 'frm_lp_principal', turnstileToken: 'tok' },
    });
  });

  it('reports missing, malformed and oversized values', () => {
    expect(parseEnvelope(null)).toEqual({
      ok: false,
      error: [
        { field: 'form_key', code: 'required' },
        { field: 'turnstile_token', code: 'required' },
      ],
    });
    expect(parseEnvelope({ form_key: 'FRM_X', turnstile_token: 5 })).toEqual({
      ok: false,
      error: [
        { field: 'form_key', code: 'invalid_format' },
        { field: 'turnstile_token', code: 'invalid_format' },
      ],
    });
    expect(parseEnvelope({ form_key: 'frm_ok1', turnstile_token: 'a'.repeat(2049) })).toEqual({
      ok: false,
      error: [{ field: 'turnstile_token', code: 'too_long' }],
    });
    expect(parseEnvelope({ form_key: '', turnstile_token: '' })).toEqual({
      ok: false,
      error: [
        { field: 'form_key', code: 'required' },
        { field: 'turnstile_token', code: 'required' },
      ],
    });
  });

  it('keeps the Turnstile token opaque: no trimming or normalization', () => {
    expect(parseEnvelope({ form_key: 'frm_ok1', turnstile_token: ' 0.Abé ' })).toEqual({
      ok: true,
      value: { formKey: 'frm_ok1', turnstileToken: ' 0.Abé ' },
    });
  });
});
