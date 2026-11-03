import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MIN_PEPPER_BYTES = 32;
const HEX_PATTERN = /^[0-9a-f]*$/;

/** SHA-256 hex digest of a UTF-8 string (idempotency request hash, ads user_data hashing). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Keyed hash used for IP/e-mail identifiers in Redis keys and analytics (never reversible). */
export type HmacHasher = (value: string) => string;

/**
 * Builds an HMAC-SHA256 hasher from the base64 `HASH_PEPPER`. Throws if the pepper decodes to
 * fewer than 32 bytes so a weak key can never reach production silently.
 */
export function createHmacHasher(pepperBase64: string): HmacHasher {
  const key = Buffer.from(pepperBase64, 'base64');
  if (key.length < MIN_PEPPER_BYTES) {
    throw new Error(`HASH_PEPPER must decode to at least ${MIN_PEPPER_BYTES} bytes`);
  }
  return (value) => createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two lowercase hex strings (signatures, hashes). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
