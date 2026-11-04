import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
} from 'jose';
import type {
  StaffMembershipLookup,
  StaffMembershipResolver,
} from '#/platform/auth/staff-membership.ts';
import {
  STAFF_RATE_LIMITS,
  type StaffLimitScope,
  type StaffRateLimiter,
  type StaffRateVerdict,
} from '#/platform/auth/staff-rate-limiter.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Clock } from '#/shared/time.ts';

/** Fixed "now" of the staff-auth tests; the verifier receives it as its clock. */
export const AUTH_NOW = new Date('2026-11-04T12:00:00.000Z');
export const AUTH_NOW_SECONDS = AUTH_NOW.getTime() / 1000;

export const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
export const ISSUER = `${SUPABASE_URL}/auth/v1`;
export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

export const USER_ID = '0196f1a0-aaaa-4000-8000-000000000001' as UserId;
export const OTHER_USER_ID = '0196f1a0-aaaa-4000-8000-000000000002' as UserId;
export const WORKSPACE_A = '0196f1a0-bbbb-7000-8000-00000000000a' as WorkspaceId;
export const WORKSPACE_B = '0196f1a0-bbbb-7000-8000-00000000000b' as WorkspaceId;

export interface TestKey {
  readonly kid: string;
  readonly alg: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

export async function createTestKey(alg: string, kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, publicJwk };
}

export interface MintOptions {
  readonly key: TestKey;
  /** Overrides the default claims; `undefined` values remove the claim. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Extra protected-header parameters (`jku`, `jwk`, `x5u`, ...). */
  readonly header?: Readonly<Record<string, unknown>>;
  /** Header `alg` / `kid` overrides without changing the signing key. */
  readonly kid?: string;
}

export function defaultClaims(): JWTPayload & Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: 'authenticated',
    sub: USER_ID,
    role: 'authenticated',
    email: 'vendedora@empresa.com.br',
    iat: AUTH_NOW_SECONDS - 60,
    exp: AUTH_NOW_SECONDS + 840,
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: AUTH_NOW_SECONDS - 60 }],
    session_id: '0196f1a0-cccc-4000-8000-000000000001',
    is_anonymous: false,
  };
}

export async function mintToken(options: MintOptions): Promise<string> {
  // JSON serialization drops `undefined` values, which is how a test removes a default claim.
  const payload: Record<string, unknown> = { ...defaultClaims(), ...options.claims };
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: options.key.alg,
      kid: options.kid ?? options.key.kid,
      typ: 'JWT',
      ...options.header,
    })
    .sign(options.key.privateKey);
}

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A syntactically complete token that claims `alg: none` and carries no signature. */
export function unsecuredToken(claims: Readonly<Record<string, unknown>> = {}): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ ...defaultClaims(), ...claims })}.`;
}

/** HS256 token whose HMAC secret is the (public) JWK of the real signing key: the classic confusion attack. */
export async function hs256WithPublicKey(key: TestKey): Promise<string> {
  const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
  return new SignJWT(defaultClaims())
    .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'JWT' })
    .sign(secret);
}

export interface FakeJwksEndpoint {
  /** `fetch` implementation for `createSupabaseKeySource`. */
  readonly fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  readonly calls: string[];
  /** What the endpoint does next. */
  mode: 'ok' | 'down' | 'not_found' | 'redirect' | 'malformed' | 'hang';
  keys: JWK[];
}

export function createFakeJwksEndpoint(keys: readonly JWK[]): FakeJwksEndpoint {
  const calls: string[] = [];
  const endpoint: FakeJwksEndpoint = {
    calls,
    mode: 'ok',
    keys: [...keys],
    fetch: (url, init) => {
      calls.push(url);
      switch (endpoint.mode) {
        case 'ok':
          return Promise.resolve(Response.json({ keys: endpoint.keys } satisfies JSONWebKeySet));
        case 'down':
          return Promise.reject(new TypeError('fetch failed'));
        case 'not_found':
          return Promise.resolve(new Response('nope', { status: 404 }));
        case 'redirect':
          return Promise.resolve(
            new Response(null, { status: 302, headers: { Location: 'https://evil.example/jwks' } }),
          );
        case 'malformed':
          return Promise.resolve(Response.json({ keys: 'not-an-array' }));
        case 'hang':
          return new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(init.signal.reason as Error);
            });
          });
      }
    },
  };
  return endpoint;
}

/** Membership table keyed by user id; users not in the map have no active membership. */
export class FakeMembershipResolver implements StaffMembershipResolver {
  readonly lookups: UserId[] = [];
  readonly #results = new Map<string, StaffMembershipLookup>();

  set(userId: UserId, result: StaffMembershipLookup): this {
    this.#results.set(userId, result);
    return this;
  }

  resolve(userId: UserId): Promise<StaffMembershipLookup> {
    this.lookups.push(userId);
    return Promise.resolve(this.#results.get(userId) ?? { kind: 'none' });
  }
}

/** Fixed-window in-memory limiter honoring the contract limits; `unavailable` simulates Redis down. */
export class InMemoryStaffRateLimiter implements StaffRateLimiter {
  readonly subjects: { scope: StaffLimitScope; subject: string }[] = [];
  unavailable = false;
  readonly #counters = new Map<string, { count: number; resetAt: number }>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  consume(scope: StaffLimitScope, subject: string): Promise<StaffRateVerdict> {
    this.subjects.push({ scope, subject });
    if (this.unavailable) return Promise.resolve({ outcome: 'unavailable' });
    const { limit, windowSeconds } = STAFF_RATE_LIMITS[scope];
    const now = this.#clock.now().getTime();
    const key = `${scope}|${subject}`;
    const current = this.#counters.get(key);
    const entry =
      current === undefined || current.resetAt <= now
        ? { count: 0, resetAt: now + windowSeconds * 1000 }
        : current;
    entry.count += 1;
    this.#counters.set(key, entry);
    return Promise.resolve(
      entry.count > limit
        ? { outcome: 'limited', retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) }
        : { outcome: 'allowed' },
    );
  }
}
