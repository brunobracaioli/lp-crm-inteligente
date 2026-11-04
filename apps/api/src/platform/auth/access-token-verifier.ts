import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type RemoteJWKSetOptions,
} from 'jose';
import { z } from 'zod';
import type { AuthenticatorAssuranceLevel } from '#/platform/auth/staff.ts';
import type { UserId } from '#/shared/ids.ts';

/**
 * Access-token verification for the staff API (contract `staffBearer`, threat model crm-staff-auth C1-C6, C12).
 *
 * Supabase claim shapes (checked 2026-11-04):
 * - https://supabase.com/docs/guides/auth/jwt-fields — `aal` is `aal1` | `aal2` (absent = aal1); `amr` is an
 *   array of `{ method, timestamp }` (Unix seconds), most recent method first; `role` is `authenticated` for
 *   signed-in users; `is_anonymous` flags anonymous sign-ins; `iss` is `<project>/auth/v1`; `aud` is
 *   `authenticated`; `session_id` identifies the session.
 * - https://supabase.com/docs/guides/auth/auth-mfa — after a TOTP verification an `amr` entry with method
 *   `totp` is added and `aal` becomes `aal2`. GoTrue names the other second factors `mfa/phone` and
 *   `mfa/webauthn`; `mfa/totp` is accepted too in case a deployment reports it with the namespaced form.
 * - https://supabase.com/docs/guides/auth/signing-keys — projects with asymmetric signing keys publish them at
 *   `<project>/auth/v1/.well-known/jwks.json` (ES256 or RS256). Supabase has no `auth_time` claim.
 */

/** `alg` allowlist, fixed server-side: never `none`, never HS* (a public key must not become an HMAC secret). */
export const ACCESS_TOKEN_ALGORITHMS: readonly string[] = ['ES256', 'RS256'];
export const ACCESS_TOKEN_AUDIENCE = 'authenticated';
/** Tolerated clock difference with the IdP for `exp`/`nbf` (contract: ≤ 5 s). */
export const CLOCK_TOLERANCE_SECONDS = 5;
/** Sanity bound on `exp - iat`; the project issues 15-minute tokens (`jwt_expiry = 900`). */
export const MAX_TOKEN_LIFETIME_SECONDS = 3600;
/** Upper bound of a compact JWT we are willing to parse (ES256/RS256 Supabase tokens are well below). */
export const MAX_TOKEN_LENGTH = 4096;

/** `amr[].method` values that prove a second factor (not password, otp, magiclink, token_refresh, ...). */
const MFA_METHODS: ReadonlySet<string> = new Set(['totp', 'mfa/totp', 'mfa/phone', 'mfa/webauthn']);

const MS_PER_SECOND = 1000;
const MAX_AMR_ENTRIES = 32;
const MAX_EMAIL_LENGTH = 254;
const JWKS_TIMEOUT_MS = 3000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 600_000;

/** Why verification refused a token. For metrics/logs only; the HTTP response never carries it. */
export type InvalidTokenReason =
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'key_not_found'
  | 'claims'
  | 'expired'
  | 'not_yet_valid'
  | 'issuer'
  | 'audience'
  | 'lifetime'
  | 'not_staff_account';

export class InvalidAccessTokenError extends Error {
  readonly reason: InvalidTokenReason;

  constructor(reason: InvalidTokenReason, options?: { readonly cause?: unknown }) {
    super(`invalid access token: ${reason}`, options);
    this.name = 'InvalidAccessTokenError';
    this.reason = reason;
  }
}

/** The signing keys could not be obtained (JWKS down, slow, redirected or malformed) and none is cached. */
export class SigningKeysUnavailableError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super('signing keys unavailable', options);
    this.name = 'SigningKeysUnavailableError';
  }
}

export interface VerifiedAccessToken {
  /** `sub`: the Supabase Auth user id. */
  readonly userId: UserId;
  readonly email: string;
  readonly aal: AuthenticatorAssuranceLevel;
  /** Most recent MFA entry of `amr`; null when the token carries none. */
  readonly mfaVerifiedAt: Date | null;
  readonly sessionId: string | null;
}

export interface AccessTokenVerifier {
  /** Throws `InvalidAccessTokenError` or `SigningKeysUnavailableError`; never returns an unverified token. */
  verify(token: string): Promise<VerifiedAccessToken>;
}

/**
 * Claims read AFTER the signature is verified. Unknown claims (app_metadata, user_metadata, phone...) are
 * ignored on purpose: the role and the workspace never come from them (C16), so they are never parsed.
 */
const claimsSchema = z.object({
  sub: z.uuid(),
  role: z.literal(ACCESS_TOKEN_AUDIENCE),
  email: z.email().max(MAX_EMAIL_LENGTH),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  aal: z.enum(['aal1', 'aal2']).default('aal1'),
  amr: z
    .array(z.object({ method: z.string().max(64), timestamp: z.number().int().positive() }))
    .max(MAX_AMR_ENTRIES)
    .default([]),
  session_id: z.uuid().optional(),
  is_anonymous: z.boolean().default(false),
});

/** Issuer and JWKS URL, both derived from the project URL: no extra configuration to get wrong. */
export function supabaseAuthEndpoints(supabaseUrl: string): { issuer: string; jwksUrl: URL } {
  const base = new URL(supabaseUrl);
  const issuer = `${base.origin}/auth/v1`;
  return { issuer, jwksUrl: new URL(`${issuer}/.well-known/jwks.json`) };
}

export interface SupabaseKeySourceOptions {
  readonly timeoutMs?: number;
  /** Minimum time between refetches triggered by an unknown `kid` (no fetch per hostile request). */
  readonly cooldownMs?: number;
  /** How long fetched keys are trusted without refetching. */
  readonly cacheMaxAgeMs?: number;
  /** Test hook / custom transport. Must return the JWKS with HTTP 200. */
  readonly fetch?: NonNullable<RemoteJWKSetOptions[typeof customFetch]>;
}

/**
 * Remote JWKS of the project with a bounded timeout, a refetch cooldown and a cache. Redirects are never
 * followed (jose requests with `redirect: 'manual'` and accepts only 200). Keys are chosen by `kid` and `alg`
 * from this JWKS only: `jku`, `jwk` and `x5u` in a token header are never consulted (C4).
 *
 * An unknown `kid` is an invalid token; any other failure to obtain keys becomes
 * `SigningKeysUnavailableError` (fail-closed 503: a token is never accepted without a verified key).
 */
export function createSupabaseKeySource(
  jwksUrl: URL,
  options: SupabaseKeySourceOptions = {},
): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: options.timeoutMs ?? JWKS_TIMEOUT_MS,
    cooldownDuration: options.cooldownMs ?? JWKS_COOLDOWN_MS,
    cacheMaxAge: options.cacheMaxAgeMs ?? JWKS_CACHE_MAX_AGE_MS,
    ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch }),
  });
  return async (header, input) => {
    try {
      return await remote(header, input);
    } catch (error) {
      if (
        error instanceof joseErrors.JWKSNoMatchingKey ||
        error instanceof joseErrors.JWKSMultipleMatchingKeys
      ) {
        throw error;
      }
      throw new SigningKeysUnavailableError({ cause: error });
    }
  };
}

export interface AccessTokenVerifierDependencies {
  /** `https://<project>.supabase.co/auth/v1`. */
  readonly issuer: string;
  readonly keys: JWTVerifyGetKey;
  /** Injected so tests never depend on wall-clock time. */
  readonly now: () => Date;
}

function reasonFor(error: unknown): InvalidTokenReason {
  if (error instanceof joseErrors.JOSEAlgNotAllowed) return 'algorithm';
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return 'signature';
  if (error instanceof joseErrors.JWKSNoMatchingKey) return 'key_not_found';
  if (error instanceof joseErrors.JWTExpired) return 'expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return 'issuer';
    if (error.claim === 'aud') return 'audience';
    if (error.claim === 'nbf') return 'not_yet_valid';
    return 'claims';
  }
  return 'malformed';
}

function latestMfaTimestamp(amr: readonly { method: string; timestamp: number }[]): Date | null {
  const timestamps = amr
    .filter((entry) => MFA_METHODS.has(entry.method))
    .map((entry) => entry.timestamp);
  return timestamps.length === 0 ? null : new Date(Math.max(...timestamps) * MS_PER_SECOND);
}

export function createAccessTokenVerifier(
  deps: AccessTokenVerifierDependencies,
): AccessTokenVerifier {
  return {
    async verify(token) {
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        throw new InvalidAccessTokenError('malformed');
      }
      const now = deps.now();
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, deps.keys, {
          algorithms: [...ACCESS_TOKEN_ALGORITHMS],
          issuer: deps.issuer,
          audience: ACCESS_TOKEN_AUDIENCE,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: now,
          requiredClaims: ['exp', 'iat', 'sub'],
        }));
      } catch (error) {
        if (error instanceof SigningKeysUnavailableError) throw error;
        throw new InvalidAccessTokenError(reasonFor(error), { cause: error });
      }

      const parsed = claimsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new InvalidAccessTokenError('claims');
      }
      const claims = parsed.data;
      if (claims.is_anonymous) {
        throw new InvalidAccessTokenError('not_staff_account');
      }
      if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) {
        throw new InvalidAccessTokenError('lifetime');
      }
      if (claims.iat > now.getTime() / MS_PER_SECOND + CLOCK_TOLERANCE_SECONDS) {
        throw new InvalidAccessTokenError('not_yet_valid');
      }
      return {
        userId: claims.sub as UserId,
        email: claims.email,
        aal: claims.aal,
        mfaVerifiedAt: latestMfaTimestamp(claims.amr),
        sessionId: claims.session_id ?? null,
      };
    },
  };
}

/** Production wiring: derives issuer and JWKS from `SUPABASE_URL`. */
export function createSupabaseAccessTokenVerifier(
  supabaseUrl: string,
  options: SupabaseKeySourceOptions & { readonly now?: () => Date } = {},
): AccessTokenVerifier {
  const { issuer, jwksUrl } = supabaseAuthEndpoints(supabaseUrl);
  return createAccessTokenVerifier({
    issuer,
    keys: createSupabaseKeySource(jwksUrl, options),
    now: options.now ?? (() => new Date()),
  });
}
