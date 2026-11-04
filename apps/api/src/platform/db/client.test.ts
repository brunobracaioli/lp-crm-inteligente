import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_MAX_CONNECTIONS,
  createSqlClient,
  type Sql,
} from './client.ts';
import { createPostgresUnitOfWork } from './postgres-unit-of-work.ts';
import { unwrapTransaction } from './transaction.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

const URL = 'postgresql://lp_api.ref:secret@db.example.com:6543/postgres';
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

/** Inspects the driver's parsed options; no connection is opened (the client is lazy). */
async function optionsOf(sql: Sql): Promise<Sql['options']> {
  const { options } = sql;
  await sql.end({ timeout: 0 });
  return options;
}

describe('createSqlClient', () => {
  it('is pooler-safe: no prepared statements, no type fetch, a small pool and timeouts', async () => {
    const options = await optionsOf(createSqlClient({ url: URL }));

    expect(options).toMatchObject({
      prepare: false,
      fetch_types: false,
      max: DEFAULT_MAX_CONNECTIONS,
      idle_timeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
      connect_timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
    });
  });

  it('pins TLS to the given CA with full certificate verification', async () => {
    const caCertBase64 = Buffer.from(CA_PEM).toString('base64');

    const options = await optionsOf(createSqlClient({ url: URL, caCertBase64 }));

    expect(options.ssl).toEqual({ ca: CA_PEM, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  });

  it('leaves TLS to the URL sslmode when no CA is given and never disables verification', async () => {
    const options = await optionsOf(
      createSqlClient({ url: `${URL}?sslmode=verify-full`, caCertBase64: undefined }),
    );

    expect(options.ssl).toBe('verify-full');
  });

  it('lets the composition root hook the client (attachDatabasePool)', async () => {
    const onClientCreated = vi.fn();

    const sql = createSqlClient({ url: URL }, { onClientCreated, maxConnections: 2 });
    await sql.end({ timeout: 0 });

    expect(onClientCreated).toHaveBeenCalledExactlyOnceWith(sql);
  });
});

describe('createPostgresUnitOfWork', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects the statement timeout %s', (statementTimeoutMs) => {
    const sql = createSqlClient({ url: URL });

    expect(() => createPostgresUnitOfWork(sql, { statementTimeoutMs })).toThrow(RangeError);
  });
});

describe('unwrapTransaction', () => {
  it('refuses a handle that was not created by the unit of work', () => {
    const foreign = Object.freeze({}) as unknown as Transaction;

    expect(() => unwrapTransaction(foreign)).toThrow(TypeError);
  });
});
