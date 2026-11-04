import type { MiddlewareHandler } from 'hono';
import { HttpProblem } from '#/platform/errors/problem.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';

/**
 * Staff identity for `/v1/crm/*` (contract: securitySchemes.staffBearer, threat model
 * crm-staff-auth). Frozen seam between the authentication middleware and the CRM routes: the
 * routes only read `c.get('staff')`; how the principal is built (JWKS, membership lookup) lives
 * behind `StaffGuards.authenticate`.
 */

export const STAFF_ROLES = ['owner', 'admin', 'sales', 'viewer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type AuthenticatorAssuranceLevel = 'aal1' | 'aal2';

export interface StaffPrincipal {
  /** `sub` of the verified access token (auth.users.id). */
  readonly userId: UserId;
  /** From core.workspace_members for `sub`; never from a client-controlled parameter. */
  readonly workspaceId: WorkspaceId;
  readonly role: StaffRole;
  readonly displayName: string;
  readonly aal: AuthenticatorAssuranceLevel;
  /** Most recent MFA verification (`amr[].timestamp` of an MFA method); null without MFA. */
  readonly mfaVerifiedAt: Date | null;
}

/** Hono environment of every staff route: AppEnv plus the authenticated principal. */
export interface StaffEnv {
  Variables: AppEnv['Variables'] & {
    staff: StaffPrincipal;
  };
}

/** Per-user rate-limit buckets (contract `x-rate-limit`). */
export type StaffRateBucket = 'read' | 'write' | 'export';

/** What happens when the limiter backend is unavailable (contract `x-rate-limit.fail`). */
export type RateLimitFailMode = 'open' | 'closed';

/**
 * Middleware supplied by the composition root. Order on every route (contract, staffBearer):
 * authenticate (401) → rateLimit → requireRole (403) → requireRecentMfa (403) → resource checks.
 */
export interface StaffGuards {
  /** Verifies the bearer token and resolves the membership; sets `staff` or throws 401/403. */
  readonly authenticate: MiddlewareHandler<StaffEnv>;
  readonly rateLimit: (
    bucket: StaffRateBucket,
    fail: RateLimitFailMode,
  ) => MiddlewareHandler<StaffEnv>;
}

/** Contract `x-max-auth-age-seconds` for export, data-export and anonymize (confirm). */
export const MAX_MFA_AGE_SECONDS = 300;

/** Throws `403 forbidden` unless the principal has one of `roles`. */
export function assertRole(principal: StaffPrincipal, roles: readonly StaffRole[]): void {
  if (!roles.includes(principal.role)) {
    throw new HttpProblem(403, 'forbidden');
  }
}

/**
 * Throws `403 mfa_required` without AAL2, and `403 reauthentication_required` when the last MFA
 * verification is older than `maxAgeSeconds` (or in the future beyond clock skew).
 */
export function assertRecentMfa(
  principal: StaffPrincipal,
  now: Date,
  maxAgeSeconds: number = MAX_MFA_AGE_SECONDS,
): void {
  if (principal.aal !== 'aal2' || principal.mfaVerifiedAt === null) {
    throw new HttpProblem(403, 'mfa_required');
  }
  const ageSeconds = (now.getTime() - principal.mfaVerifiedAt.getTime()) / 1000;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -MFA_CLOCK_SKEW_SECONDS) {
    throw new HttpProblem(403, 'reauthentication_required');
  }
}

/** Tolerated forward skew between the IdP clock and ours. */
const MFA_CLOCK_SKEW_SECONDS = 60;

/** Route middleware form of `assertRole`. */
export function requireRole(...roles: StaffRole[]): MiddlewareHandler<StaffEnv> {
  return async (c, next) => {
    assertRole(c.get('staff'), roles);
    await next();
  };
}

/** Route middleware form of `assertRecentMfa`, with an injectable clock. */
export function requireRecentMfa(
  now: () => Date,
  maxAgeSeconds: number = MAX_MFA_AGE_SECONDS,
): MiddlewareHandler<StaffEnv> {
  return async (c, next) => {
    assertRecentMfa(c.get('staff'), now(), maxAgeSeconds);
    await next();
  };
}
