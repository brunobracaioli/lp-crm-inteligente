import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AREAS_OF_EXPERTISE, COMPANY_SIZES } from '#/shared/lead-profile.ts';
import { parseEmail } from '#/modules/lead-capture/domain/email.ts';
import {
  TEXT_RULES,
  TRACKING_RULES,
  satisfiesE164Rule,
  satisfiesEmailRule,
  satisfiesTextRule,
  type TextRule,
} from '#/modules/lead-capture/domain/rules.ts';
import {
  parseEnvelope,
  parseSubmission,
  type SubmissionSnapshot,
} from '#/modules/lead-capture/domain/submission.ts';
import { readText } from '#/modules/lead-capture/domain/text.ts';
import { parseWebsite } from '#/modules/lead-capture/domain/url.ts';
import { parseWhatsapp } from '#/modules/lead-capture/domain/whatsapp.ts';

/**
 * AC-LC-13 (half without I/O): for arbitrary Unicode input the validators never throw, and every
 * accepted value satisfies `domain/rules.ts`. The CHECK-constraint half runs in Wave 4.
 */

const ORIGINS = ['https://www.dominio.com.br'];
const NUM_RUNS = 300;

/** Any UTF-16 unit sequence, lone surrogates included. */
const binaryText = fc.string({ unit: 'binary', maxLength: 140 });
/** Full code points, grapheme clusters and the usual suspects (zero-width, bidi, controls). */
const graphemeText = fc.string({ unit: 'grapheme', maxLength: 70 });
const suspiciousText = fc.string({
  unit: fc.constantFrom(
    'a',
    'Z',
    'é',
    'ç',
    ' ',
    '\u00A0',
    '\u200B',
    '\u202E',
    '\uFEFF',
    '\u0000',
    '\n',
    '\r',
    '\t',
    "'",
    '-',
    '.',
    ',',
    '&',
    '(',
    ')',
    '/',
    '+',
    '1',
    '<',
    '😀',
    '\u0301',
  ),
  maxLength: 80,
});
const nameLikeText = fc.string({
  unit: fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyzáéíóúãõçÁÉ '-.")),
  maxLength: 90,
});
const anyText = fc.oneof(binaryText, graphemeText, suspiciousText, nameLikeText);
const anyValue = fc.oneof(anyText, fc.anything());

function expectTextAccepted(value: string, rule: TextRule, multiline = false): void {
  expect(satisfiesTextRule(value, rule, multiline)).toBe(true);
}

describe('AC-LC-13: field validators over arbitrary Unicode', () => {
  it('AC-LC-13: readText never throws and every accepted value satisfies its text rule', () => {
    let accepted = 0;
    fc.assert(
      fc.property(anyValue, (raw) => {
        for (const rule of [
          TEXT_RULES.firstName,
          TEXT_RULES.lastName,
          TEXT_RULES.company,
          TEXT_RULES.areaOfExpertiseOther,
          TEXT_RULES.jobTitle,
          TRACKING_RULES.utm,
          TRACKING_RULES.clickId,
          TRACKING_RULES.metaBrowserId,
          TRACKING_RULES.gaClientId,
        ]) {
          const result = readText(raw, rule);
          if (result.ok) {
            accepted += 1;
            expectTextAccepted(result.value, rule);
          }
        }
        const message = readText(raw, TEXT_RULES.message, true);
        if (message.ok) {
          accepted += 1;
          expectTextAccepted(message.value, TEXT_RULES.message, true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it('AC-LC-13: parseEmail never throws and every accepted address satisfies the e-mail rule', () => {
    let accepted = 0;
    fc.assert(
      fc.property(fc.oneof(anyValue, fc.emailAddress()), (raw) => {
        const result = parseEmail(raw);
        if (result.ok) {
          accepted += 1;
          expect(satisfiesEmailRule(result.value)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it('AC-LC-13: parseWhatsapp never throws and every accepted number is E.164', () => {
    const plausiblePhone = fc
      .tuple(
        fc.integer({ min: 11, max: 99 }),
        fc.integer({ min: 900_000_000, max: 999_999_999 }),
        fc.constantFrom('', '+55', '55', '+'),
      )
      .map(([area, subscriber, prefix]) => `${prefix}${String(area)}${String(subscriber)}`);
    let accepted = 0;
    fc.assert(
      fc.property(fc.oneof(anyValue, plausiblePhone), (raw) => {
        const result = parseWhatsapp(raw);
        if (result.ok) {
          accepted += 1;
          expect(satisfiesE164Rule(result.value)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it('AC-LC-13: parseWebsite never throws and every accepted URL is a short http(s) URL', () => {
    const plausibleHost = fc
      .tuple(
        fc.constantFrom('empresa', 'a-b', 'x1', 'www.loja'),
        fc.constantFrom('com', 'com.br', 'io'),
      )
      .map(([name, tld]) => `${name}.${tld}`);
    let accepted = 0;
    fc.assert(
      fc.property(fc.oneof(anyValue, plausibleHost), (raw) => {
        const result = parseWebsite(raw);
        if (result.ok) {
          accepted += 1;
          expect(result.value).toMatch(/^https?:\/\//);
          expect(result.value.length).toBeLessThanOrEqual(200);
          expect(result.value).not.toMatch(/[\s\p{Cc}\p{Cf}]/u);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it('AC-LC-13: parseEnvelope and parseSubmission never throw for arbitrary JSON-like bodies', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.anything(), fc.object({ key: anyText, values: [anyValue] })),
        (body) => {
          parseEnvelope(body);
          parseSubmission(body, { allowedOrigins: ORIGINS });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

function assertSnapshotSatisfiesRules(snapshot: SubmissionSnapshot): void {
  expectTextAccepted(snapshot.firstName, TEXT_RULES.firstName);
  expectTextAccepted(snapshot.lastName, TEXT_RULES.lastName);
  expectTextAccepted(snapshot.companyName, TEXT_RULES.company);
  expect(satisfiesEmailRule(snapshot.email)).toBe(true);
  expect(satisfiesE164Rule(snapshot.whatsappE164)).toBe(true);
  expect(AREAS_OF_EXPERTISE).toContain(snapshot.areaOfExpertise);
  // DB CHECK mirror: (area = 'other') = (area_other IS NOT NULL)
  expect(snapshot.areaOfExpertise === 'other').toBe(snapshot.areaOfExpertiseOther !== null);
  if (snapshot.areaOfExpertiseOther !== null) {
    expectTextAccepted(snapshot.areaOfExpertiseOther, TEXT_RULES.areaOfExpertiseOther);
  }
  if (snapshot.jobTitle !== null) {
    expectTextAccepted(snapshot.jobTitle, TEXT_RULES.jobTitle);
  }
  if (snapshot.companySize !== null) {
    expect(COMPANY_SIZES).toContain(snapshot.companySize);
  }
  if (snapshot.companyWebsite !== null) {
    expect(snapshot.companyWebsite).toMatch(/^https?:\/\//);
    expect(snapshot.companyWebsite.length).toBeLessThanOrEqual(200);
  }
  if (snapshot.message !== null) {
    expectTextAccepted(snapshot.message, TEXT_RULES.message, true);
  }
  expect(snapshot.privacyConsent).toBe(true);
  const { attribution } = snapshot;
  for (const utm of [
    attribution.utmSource,
    attribution.utmMedium,
    attribution.utmCampaign,
    attribution.utmTerm,
    attribution.utmContent,
    attribution.utmId,
  ]) {
    if (utm !== null) {
      expectTextAccepted(utm, TRACKING_RULES.utm);
    }
  }
  for (const clickId of [
    attribution.gclid,
    attribution.gbraid,
    attribution.wbraid,
    attribution.fbclid,
    attribution.ttclid,
    attribution.msclkid,
  ]) {
    if (clickId !== null) {
      expectTextAccepted(clickId, TRACKING_RULES.clickId);
    }
  }
  for (const browserId of [attribution.fbp, attribution.fbc]) {
    if (browserId !== null) {
      expectTextAccepted(browserId, TRACKING_RULES.metaBrowserId);
    }
  }
  if (attribution.gaClientId !== null) {
    expectTextAccepted(attribution.gaClientId, TRACKING_RULES.gaClientId);
  }
  if (attribution.landingPageUrl !== null) {
    expect(attribution.landingPageUrl.startsWith(ORIGINS[0] ?? '')).toBe(true);
  }
}

describe('AC-LC-13: whole submission over arbitrary Unicode', () => {
  const optional = <T>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: undefined });
  /** Mostly plausible values (so many bodies are accepted), sometimes arbitrary noise. */
  const mostly = <T>(valid: fc.Arbitrary<T>, noise: fc.Arbitrary<unknown> = anyValue) =>
    fc.oneof({ weight: 6, arbitrary: valid }, { weight: 1, arbitrary: noise });
  const bodyArbitrary = fc.record(
    {
      form_key: fc.constantFrom('frm_lp_principal', 'frm_x'),
      turnstile_token: anyText,
      first_name: mostly(fc.constantFrom('Maria', "João D'Ávila-Souza", 'Zoë')),
      last_name: mostly(fc.constantFrom('Silva', 'de Oliveira')),
      email: mostly(
        fc.constantFrom('maria@empresa.com.br', 'Joao.Silva+crm@Gmail.com'),
        fc.oneof(anyValue, fc.emailAddress()),
      ),
      whatsapp: mostly(fc.constantFrom('11912345678', '+55 (21) 98888-7777', '+1 415 555 2671')),
      company: mostly(fc.constantFrom('Empresa Ltda', 'A&B (Brasil) S/A')),
      area_of_expertise: mostly(fc.constantFrom(...AREAS_OF_EXPERTISE)),
      area_of_expertise_other: optional(mostly(fc.constantFrom('Gestão de frotas'))),
      job_title: optional(mostly(fc.constantFrom('Head de Marketing'))),
      company_size: optional(mostly(fc.constantFrom(...COMPANY_SIZES))),
      company_website: optional(mostly(fc.constantFrom('empresa.com.br', 'https://x.io/a?b=1'))),
      message: optional(mostly(fc.constantFrom('Preciso de ajuda\r\ncom o CRM', 'Olá'))),
      marketing_opt_in: optional(mostly(fc.boolean())),
      privacy_consent: mostly(fc.constant(true)),
      hp: optional(anyValue),
      consent: optional(
        mostly(
          fc.record(
            {
              ad_storage: fc.constantFrom('granted', 'denied'),
              ad_user_data: mostly(fc.constant('granted')),
            },
            { requiredKeys: [] },
          ),
        ),
      ),
      tracking: optional(
        mostly(
          fc.record(
            {
              event_id: mostly(fc.uuid()),
              utm_source: mostly(fc.constantFrom('meta', 'google ads')),
              gclid: mostly(fc.constantFrom('Cj0KCQ_abc-123~x')),
              fbp: mostly(fc.constantFrom('fb.1.1730600000000.123456789')),
              landing_page_url: mostly(
                fc.constantFrom('https://www.dominio.com.br/?a=1', 'https://evil.example/'),
              ),
              referrer_url: mostly(fc.constantFrom('https://l.facebook.com/')),
            },
            { requiredKeys: [] },
          ),
        ),
      ),
    },
    { requiredKeys: ['form_key'] },
  );

  it('AC-LC-13: never throws, and every accepted submission satisfies domain/rules.ts', () => {
    let accepted = 0;
    fc.assert(
      fc.property(bodyArbitrary, (body) => {
        const result = parseSubmission(body, { allowedOrigins: ORIGINS });
        if (result.ok) {
          accepted += 1;
          assertSnapshotSatisfiesRules(result.value.snapshot);
        } else {
          expect(result.error.length).toBeGreaterThan(0);
          expect(result.error.length).toBeLessThanOrEqual(50);
        }
      }),
      { numRuns: 1000 },
    );
    expect(accepted).toBeGreaterThan(0);
  });
});
