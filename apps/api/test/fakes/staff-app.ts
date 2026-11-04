import { Writable } from 'node:stream';
import { Hono } from 'hono';
import { createApp } from '#/app.ts';
import {
  createAccessTokenVerifier,
  createSupabaseKeySource,
} from '#/platform/auth/access-token-verifier.ts';
import { createStaffGuards } from '#/platform/auth/staff-guards.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createHmacHasher } from '#/platform/crypto/hashing.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';
import type { StaffEnv, StaffGuards } from '#/platform/auth/staff.ts';
import { FakeClock } from './clock.ts';
import {
  AUTH_NOW,
  ISSUER,
  JWKS_URL,
  USER_ID,
  WORKSPACE_A,
  FakeMembershipResolver,
  InMemoryStaffRateLimiter,
  createFakeJwksEndpoint,
  createTestKey,
  type FakeJwksEndpoint,
  type TestKey,
} from './staff-auth.ts';

export const LP_ORIGIN = 'https://www.example.com.br';
export const CRM_ORIGIN = 'https://crm.example.com.br';
const PEPPER_BASE64 = Buffer.alloc(32, 7).toString('base64');

export interface StaffAppOptions {
  /** Builds the staff routes under test from the guards. */
  readonly routes?: (guards: StaffGuards) => Hono<StaffEnv>;
}

/** The real `createApp` with the real guards over a fake JWKS, fake membership table and in-memory limiter. */
export async function buildStaffApp(options: StaffAppOptions = {}) {
  const es = await createTestKey('ES256', 'key-es256');
  const rs = await createTestKey('RS256', 'key-rs256');
  const endpoint: FakeJwksEndpoint = createFakeJwksEndpoint([es.publicJwk, rs.publicJwk]);
  const clock = new FakeClock(AUTH_NOW);
  const memberships = new FakeMembershipResolver().set(USER_ID, {
    kind: 'member',
    membership: { workspaceId: WORKSPACE_A, role: 'sales', displayName: 'Marina Souza' },
  });
  const limiter = new InMemoryStaffRateLimiter(clock);
  const metrics = createRecordingMetrics();
  const logLines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString('utf8'));
      callback();
    },
  });

  const verifier = createAccessTokenVerifier({
    issuer: ISSUER,
    keys: createSupabaseKeySource(new URL(JWKS_URL), { fetch: endpoint.fetch }),
    now: () => clock.now(),
  });
  const guards = createStaffGuards({
    verifier,
    memberships,
    limiter,
    metrics,
    hmac: createHmacHasher(PEPPER_BASE64),
    trustVercelProxy: true,
  });

  const defaultRoutes = (g: StaffGuards): Hono<StaffEnv> =>
    new Hono<StaffEnv>().get('/v1/crm/whoami', g.authenticate, (c) => c.json(c.get('staff')));
  const staffRoutes = (options.routes ?? defaultRoutes)(guards);

  const app = createApp({
    config: loadConfig({
      APP_ENV: 'development',
      CORS_ALLOWED_ORIGINS: LP_ORIGIN,
      CRM_WEB_ORIGINS: CRM_ORIGIN,
    }),
    logger: createLogger({ level: 'info', appEnv: 'test', destination }),
    routes: [staffRoutes],
  });

  return { app, es, rs, endpoint, clock, memberships, limiter, metrics, logLines, guards };
}

export type StaffApp = Awaited<ReturnType<typeof buildStaffApp>>;

export function bearer(token: string, extra: Record<string, string> = {}): RequestInit {
  return { headers: { Authorization: `Bearer ${token}`, 'X-Real-IP': '203.0.113.9', ...extra } };
}

export type { TestKey };
