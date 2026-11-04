/** Exact match of the request `Origin` against `form.allowed_origins` (lead-capture §3, step 5). */
export function isOriginAllowed(origin: string | null, allowedOrigins: readonly string[]): boolean {
  return origin !== null && origin !== '' && allowedOrigins.includes(origin);
}

/**
 * Turnstile hostnames derive from the form's allowed origins (lead-capture §6). Origins that do
 * not parse are skipped, so a corrupt entry can only shrink the set, never widen it.
 */
export function hostnamesOfOrigins(allowedOrigins: readonly string[]): readonly string[] {
  const hostnames = new Set<string>();
  for (const origin of allowedOrigins) {
    try {
      hostnames.add(new URL(origin).hostname);
    } catch {
      // Skipped on purpose: see above.
    }
  }
  return [...hostnames];
}
