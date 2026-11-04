import { randomBytes } from 'node:crypto';
import type { IdGenerator } from '#/shared/ids.ts';

const UUID_VERSION_7 = 0x70;
const UUID_VARIANT_RFC = 0x80;
const TIMESTAMP_BYTES = 6;

/** Real, globally unique UUID v7 values: the integration database keeps rows across tests. */
export class RandomUuidV7Generator implements IdGenerator {
  uuidv7(): string {
    const bytes = randomBytes(16);
    bytes.writeUIntBE(Date.now(), 0, TIMESTAMP_BYTES);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | UUID_VERSION_7;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | UUID_VARIANT_RFC;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
