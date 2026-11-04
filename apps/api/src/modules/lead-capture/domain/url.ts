import { err, ok, type Result } from '#/shared/result.ts';
import type { FieldErrorCode } from '#/modules/lead-capture/domain/field-error.ts';
import {
  RESERVED_HOST_SUFFIXES,
  RESERVED_HOSTS,
  TRACKING_URL_MAX_LENGTH,
  WEBSITE_MAX_LENGTH,
} from '#/modules/lead-capture/domain/rules.ts';
import { codePointLength, normalizeText } from '#/modules/lead-capture/domain/text.ts';

const EXPLICIT_HTTP_SCHEME = /^https?:\/\//i;
/** Any `scheme:` prefix, with or without `//` (catches `javascript:`, `ftp://`, `host:8080`). */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Registrable-looking host: dotted labels and an alphabetic (or punycode) TLD — no IP literals. */
const PUBLIC_HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpUrlWithoutCredentials(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === ''
  );
}

function isReservedHost(hostname: string): boolean {
  return (
    RESERVED_HOSTS.some((reserved) => hostname === reserved) ||
    RESERVED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

/**
 * `company_website` (lead-capture §4.1): http(s) only (a missing scheme becomes `https://`),
 * no credentials, no non-default port, a public-looking host (no IP literal, `localhost`,
 * `.local`, `.internal`). Returns `scheme://host[/path][?query]` without fragment. The URL is
 * never fetched server-side in v1 (no SSRF surface).
 */
export function parseWebsite(raw: unknown): Result<string, FieldErrorCode> {
  if (typeof raw !== 'string') {
    return err('invalid_format');
  }
  const normalized = normalizeText(raw);
  if (!normalized.ok) {
    return normalized;
  }
  const input = normalized.value;
  if (input === '') {
    return err('required');
  }
  if (codePointLength(input) > WEBSITE_MAX_LENGTH) {
    return err('too_long');
  }
  if (!EXPLICIT_HTTP_SCHEME.test(input) && ANY_SCHEME.test(input)) {
    return err('invalid_format');
  }
  const url = tryParseUrl(EXPLICIT_HTTP_SCHEME.test(input) ? input : `https://${input}`);
  if (
    url === null ||
    !isHttpUrlWithoutCredentials(url) ||
    url.port !== '' ||
    !PUBLIC_HOSTNAME.test(url.hostname) ||
    isReservedHost(url.hostname)
  ) {
    return err('invalid_format');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname;
  const website = `${url.protocol}//${url.host}${pathname}${url.search}`;
  return codePointLength(website) > WEBSITE_MAX_LENGTH ? err('too_long') : ok(website);
}

/** `tracking.landing_page_url` / `referrer_url`: an absolute http(s) URL without credentials. */
export function parseTrackingUrl(raw: unknown): Result<string, FieldErrorCode> {
  if (typeof raw !== 'string') {
    return err('invalid_format');
  }
  const normalized = normalizeText(raw);
  if (!normalized.ok) {
    return normalized;
  }
  if (normalized.value === '') {
    return err('required');
  }
  if (codePointLength(normalized.value) > TRACKING_URL_MAX_LENGTH) {
    return err('too_long');
  }
  const url = tryParseUrl(normalized.value);
  if (
    url === null ||
    !EXPLICIT_HTTP_SCHEME.test(normalized.value) ||
    !isHttpUrlWithoutCredentials(url)
  ) {
    return err('invalid_format');
  }
  return codePointLength(url.href) > TRACKING_URL_MAX_LENGTH ? err('too_long') : ok(url.href);
}

/** Origin (`scheme://host[:port]`) of an absolute URL, or null when it does not parse. */
export function originOf(url: string): string | null {
  return tryParseUrl(url)?.origin ?? null;
}
