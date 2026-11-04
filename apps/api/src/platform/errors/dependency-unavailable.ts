/** Infrastructure dependencies whose outage is reported as `503 service_unavailable`. */
/** `identity_provider`: the JWKS of Supabase Auth could not be obtained (staff authentication, fail-closed). */
export type UnavailableDependency = 'database' | 'cache' | 'identity_provider';

/**
 * A required dependency is down or timed out (connection refused, pool exhausted, statement
 * timeout). Adapters translate their driver failure into this error; the global error handler
 * renders it as `503 service_unavailable` with `Retry-After`, never exposing the driver detail.
 * Anything else that escapes a use case stays a generic `500 internal_error`.
 */
export class DependencyUnavailableError extends Error {
  readonly dependency: UnavailableDependency;

  constructor(dependency: UnavailableDependency, options?: { readonly cause?: unknown }) {
    super(`dependency unavailable: ${dependency}`, options);
    this.name = 'DependencyUnavailableError';
    this.dependency = dependency;
  }
}
