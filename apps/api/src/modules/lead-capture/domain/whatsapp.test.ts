import { describe, expect, it } from 'vitest';
import { parseWhatsapp } from '#/modules/lead-capture/domain/whatsapp.ts';

describe('parseWhatsapp', () => {
  it.each([
    ['+55 (11) 91234-5678'],
    ['11912345678'],
    ['5511912345678'],
    ['(11) 91234-5678'],
    ['+5511912345678'],
    ['011 91234-5678'],
  ])('AC-LC-15: %s normalizes to +5511912345678', (input) => {
    expect(parseWhatsapp(input)).toEqual({ ok: true, value: '+5511912345678' });
  });

  it('AC-LC-15: 1191234567 (8 digits after the area code, no leading 9) is rejected', () => {
    expect(parseWhatsapp('1191234567')).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('accepts a valid foreign number with a country code', () => {
    expect(parseWhatsapp('+1 415 555 2671')).toEqual({ ok: true, value: '+14155552671' });
    expect(parseWhatsapp('+351 912 345 678')).toEqual({ ok: true, value: '+351912345678' });
  });

  it('rejects a Brazilian landline: WhatsApp needs a mobile number', () => {
    expect(parseWhatsapp('11 3123-4567')).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('rejects an invalid area code', () => {
    expect(parseWhatsapp('00 91234-5678')).toEqual({ ok: false, error: 'invalid_format' });
  });

  it.each([
    ['letters', '11 91234-ABCD'],
    ['symbols', '11#91234-5678'],
    ['plus in the middle', '11+912345678'],
    ['fullwidth digits', '１１９１２３４５６７８'],
    ['only punctuation', '(--)'],
  ])('rejects %s with invalid_format', (_label, input) => {
    expect(parseWhatsapp(input)).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('rejects inputs longer than 32 characters before parsing', () => {
    expect(parseWhatsapp(`+55 11 ${'9'.repeat(30)}`)).toEqual({ ok: false, error: 'too_long' });
  });

  it('rejects control and zero-width characters', () => {
    expect(parseWhatsapp('11\u200B912345678')).toEqual({
      ok: false,
      error: 'not_allowed_characters',
    });
  });

  it('rejects non-strings and blank values', () => {
    expect(parseWhatsapp(5511912345678)).toEqual({ ok: false, error: 'invalid_format' });
    expect(parseWhatsapp('   ')).toEqual({ ok: false, error: 'required' });
  });
});
