/**
 * Meta browser identifiers `fbp` / `fbc` (unhashed in the CAPI payload). Format documented by Meta:
 * `fb.<subdomain_index>.<creation_time_ms>.<value>`; the shape check mirrors lead-capture §4.3.
 */
const FB_COOKIE_SHAPE = /^fb\.[0-9]\.[0-9]{10,13}\.[A-Za-z0-9._-]+$/u;
const MAX_IDENTIFIER_LENGTH = 500;
/** Subdomain index 1 = the registrable domain (`example.com`), the value the Pixel itself writes. */
const FBC_SUBDOMAIN_INDEX = 1;

function validFbCookie(value: string | null): string | null {
  if (value === null) return null;
  const candidate = value.trim();
  return candidate.length <= MAX_IDENTIFIER_LENGTH && FB_COOKIE_SHAPE.test(candidate)
    ? candidate
    : null;
}

/** A well-formed `_fbp` value, or null (a malformed client value is dropped, never repaired). */
export function resolveFbp(fbp: string | null): string | null {
  return validFbCookie(fbp);
}

export interface FbcSources {
  readonly fbc: string | null;
  readonly fbclid: string | null;
  /** Time the click id was first seen; the submission time is the closest server-side fact. */
  readonly observedAt: Date;
}

/**
 * Prefers the `_fbc` cookie value; when absent (or malformed) and an `fbclid` is present builds
 * `fb.1.<observed_at_ms>.<fbclid>` (tracking §5.2). `fbclid` is case-sensitive: never lowercased.
 */
export function resolveFbc(sources: FbcSources): string | null {
  const fromCookie = validFbCookie(sources.fbc);
  if (fromCookie !== null) return fromCookie;
  const fbclid = sources.fbclid?.trim();
  if (fbclid === undefined || fbclid === '') return null;
  const observedAtMs = sources.observedAt.getTime();
  if (!Number.isFinite(observedAtMs)) return null;
  return validFbCookie(`fb.${FBC_SUBDOMAIN_INDEX}.${observedAtMs}.${fbclid}`);
}
