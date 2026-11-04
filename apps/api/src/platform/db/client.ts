import postgres from 'postgres';

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

/** Plain config (what `platform/config` exposes as `database`); this module never reads the env. */
export interface DatabaseConfig {
  /** `postgresql://lp_api.<ref>:<password>@<pooler-host>:6543/postgres` (Supavisor, transaction mode). */
  readonly url: string;
  /** Base64 PEM of the CA that signs the server certificate (`DATABASE_CA_CERT`). */
  readonly caCertBase64?: string | undefined;
}

export interface DatabaseClientOptions {
  /** Server-side connections kept per function instance. Small on purpose (Supavisor multiplexes). */
  readonly maxConnections?: number;
  /** Seconds an idle connection stays open before the driver closes it. */
  readonly idleTimeoutSeconds?: number;
  /** Seconds to wait for a new connection (TCP + TLS + auth). */
  readonly connectTimeoutSeconds?: number;
  /**
   * Called once with the new client so the composition root can keep the function instance alive until
   * idle connections drain (`attachDatabasePool` of `@vercel/functions`). postgres.js emits no
   * `release` events, so the hook receives the client and the root adapts it.
   */
  readonly onClientCreated?: (sql: Sql) => void;
}

export const DEFAULT_MAX_CONNECTIONS = 3;
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 20;
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 5;

interface VerifiedTls {
  readonly ca: string;
  readonly rejectUnauthorized: true;
  readonly minVersion: 'TLSv1.2';
}

/**
 * Pins the server certificate chain to `caCertBase64` with full verification (chain and host name).
 * Without a CA the driver follows the URL's `sslmode`: remote databases must set `verify-full` there
 * and ship the CA; `rejectUnauthorized: false` is never an option.
 */
function tlsOptions(caCertBase64: string | undefined): VerifiedTls | undefined {
  if (caCertBase64 === undefined || caCertBase64 === '') {
    return undefined;
  }
  return {
    ca: Buffer.from(caCertBase64, 'base64').toString('utf8'),
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
}

/**
 * Creates the Postgres client for the API. Lazy: no connection is opened until the first query.
 *
 * - `prepare: false` — Supavisor in transaction mode cannot keep named prepared statements.
 * - `fetch_types: false` — saves a round trip per new connection; array columns are read as JSON.
 * - session-level settings such as `statement_timeout` are applied per transaction by the unit of work
 *   (poolers ignore startup parameters), and the `lp_api` role carries its own defaults.
 */
export function createSqlClient(config: DatabaseConfig, options: DatabaseClientOptions = {}): Sql {
  const ssl = tlsOptions(config.caCertBase64);
  const sql = postgres(config.url, {
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    idle_timeout: options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    connect_timeout: options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
    prepare: false,
    fetch_types: false,
    onnotice: () => undefined,
    ...(ssl === undefined ? {} : { ssl }),
  });
  options.onClientCreated?.(sql);
  return sql;
}
