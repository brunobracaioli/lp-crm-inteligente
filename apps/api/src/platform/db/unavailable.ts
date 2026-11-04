import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';

/** Socket/driver codes postgres.js sets when the server cannot be reached or the link dropped. */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

/**
 * SQLSTATEs that mean "the database cannot serve now", not "this request is wrong":
 * query_canceled (statement_timeout), too_many_connections, admin/crash shutdown, cannot connect now.
 */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
  '57014',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);
/** Class 08 — connection exception. */
const CONNECTION_EXCEPTION_CLASS = '08';

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

export function isDatabaseUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined) {
    return false;
  }
  return (
    CONNECTION_ERROR_CODES.has(code) ||
    UNAVAILABLE_SQLSTATES.has(code) ||
    code.startsWith(CONNECTION_EXCEPTION_CLASS)
  );
}

/**
 * Turns an outage of the database into `DependencyUnavailableError('database')` (→ 503 with
 * Retry-After); every other error (constraint bug, rollback signal of a use case) passes unchanged.
 */
export function translateDatabaseError(error: unknown): unknown {
  return isDatabaseUnavailable(error)
    ? new DependencyUnavailableError('database', { cause: error })
    : error;
}
