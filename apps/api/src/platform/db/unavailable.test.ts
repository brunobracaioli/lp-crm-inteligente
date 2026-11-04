import { describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { isDatabaseUnavailable, translateDatabaseError } from '#/platform/db/unavailable.ts';

const withCode = (code: string): Error => Object.assign(new Error('driver failure'), { code });

describe('translateDatabaseError', () => {
  it.each(['ECONNREFUSED', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', '57014', '53300', '08006'])(
    'maps %s to a database DependencyUnavailableError keeping the cause',
    (code) => {
      // arrange
      const original = withCode(code);
      // act
      const translated = translateDatabaseError(original);
      // assert
      expect(translated).toBeInstanceOf(DependencyUnavailableError);
      expect(translated).toMatchObject({ dependency: 'database', cause: original });
    },
  );

  it.each(['23505', '23514', '42501', '40001'])(
    'leaves request-level SQLSTATE %s untouched',
    (code) => {
      // arrange
      const original = withCode(code);
      // act
      const translated = translateDatabaseError(original);
      // assert
      expect(translated).toBe(original);
    },
  );

  it('leaves errors without a code (use-case rollback signals) untouched', () => {
    // arrange
    const rollback = new Error('submission with the same idempotency key already exists');
    // act / assert
    expect(isDatabaseUnavailable(rollback)).toBe(false);
    expect(translateDatabaseError(rollback)).toBe(rollback);
  });
});
