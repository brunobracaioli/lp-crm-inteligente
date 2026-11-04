import { randomBytes } from 'node:crypto';
import type { IdGenerator } from '#/shared/ids.ts';

const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;
const VERSION_BYTE = 6;
const VARIANT_BYTE = 8;
const VERSION_7_BITS = 0x70;
const LOW_NIBBLE_MASK = 0x0f;
const RFC_9562_VARIANT_BITS = 0x80;
const VARIANT_MASK = 0x3f;

/**
 * UUID version 7 (RFC 9562 §5.7): 48-bit Unix epoch milliseconds followed by 74 random bits from the
 * CSPRNG. Time-ordered, so primary-key inserts stay index-friendly; the random part keeps ids
 * unguessable (they reach the client as `submission_id` / `event_id`).
 */
export function createUuidV7Generator(now: () => number = Date.now): IdGenerator {
  return {
    uuidv7(): string {
      const bytes = randomBytes(UUID_BYTES);
      bytes.writeUIntBE(now(), 0, TIMESTAMP_BYTES);
      bytes[VERSION_BYTE] = ((bytes[VERSION_BYTE] ?? 0) & LOW_NIBBLE_MASK) | VERSION_7_BITS;
      bytes[VARIANT_BYTE] = ((bytes[VARIANT_BYTE] ?? 0) & VARIANT_MASK) | RFC_9562_VARIANT_BITS;
      const hex = bytes.toString('hex');
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
      ].join('-');
    },
  };
}
