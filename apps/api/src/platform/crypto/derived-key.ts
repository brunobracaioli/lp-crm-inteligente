import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Purpose-bound keys derived from HASH_PEPPER (threat model crm-staff-auth, G10): no new secret,
 * and a distinct label per use so a CRM cursor MAC can never validate as a plan hash. Rotating
 * the pepper invalidates every derived value, which is harmless for cursors and plans.
 */
export type DerivedKeyLabel = 'crm-cursor-v1' | 'crm-plan-v1';

const DERIVED_KEY_BYTES = 32;

/** A keyed MAC: base64url HMAC-SHA256 of `value` under the derived key. */
export type KeyedMac = (value: string) => string;

export function deriveKey(pepperBase64: string, label: DerivedKeyLabel): Buffer {
  const ikm = Buffer.from(pepperBase64, 'base64');
  if (ikm.length === 0) {
    throw new TypeError('deriveKey: empty pepper');
  }
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), label, DERIVED_KEY_BYTES));
}

export function createKeyedMac(pepperBase64: string, label: DerivedKeyLabel): KeyedMac {
  const key = deriveKey(pepperBase64, label);
  return (value) => createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}
