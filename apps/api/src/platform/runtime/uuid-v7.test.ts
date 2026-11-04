import { describe, expect, it } from 'vitest';
import { createUuidV7Generator } from '#/platform/runtime/uuid-v7.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIXED_MS = 0x0192_3456_789a;
const SAMPLE_SIZE = 1_000;

describe('createUuidV7Generator', () => {
  it('produces RFC 9562 version 7 / variant 10 identifiers', () => {
    // arrange
    const ids = createUuidV7Generator();
    // act
    const id = ids.uuidv7();
    // assert
    expect(id).toMatch(UUID_V7);
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    // arrange
    const ids = createUuidV7Generator(() => FIXED_MS);
    // act
    const id = ids.uuidv7();
    // assert
    expect(id.replaceAll('-', '').slice(0, 12)).toBe(FIXED_MS.toString(16).padStart(12, '0'));
  });

  it('does not repeat within the same millisecond', () => {
    // arrange
    const ids = createUuidV7Generator(() => FIXED_MS);
    // act
    const generated = new Set(Array.from({ length: SAMPLE_SIZE }, () => ids.uuidv7()));
    // assert
    expect(generated.size).toBe(SAMPLE_SIZE);
  });
});
