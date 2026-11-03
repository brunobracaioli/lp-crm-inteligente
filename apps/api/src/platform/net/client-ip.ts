import { isIP } from 'node:net';
import { ipAddress } from '@vercel/functions';

/**
 * Client IP extraction (lead-capture §6, threat T21).
 *
 * On Vercel the platform proxy OVERWRITES `x-real-ip` (and `x-forwarded-for`) with the address of
 * the TCP peer, so `x-real-ip` — read through `ipAddress()` from `@vercel/functions` — is the only
 * header ever trusted. `x-forwarded-for`, `forwarded`, `cf-connecting-ip` and friends are fully
 * client-controlled in front of this API (it is not behind Cloudflare's proxy, ADR-0002) and are
 * deliberately ignored. Outside Vercel nothing overwrites `x-real-ip`, so the caller must opt in.
 */

const MAX_IP_TEXT_LENGTH = 45; // longest textual IPv6 form (IPv4-embedded)
const IPV6_GROUP_COUNT = 8;
const IPV6_GROUP_BITS = 16;
const IPV6_RATE_LIMIT_PREFIX_GROUPS = 4; // /64: the smallest allocation an ISP hands to one subscriber
const IPV4_MAPPED_GROUP = 0xffff;
const IPV4_MAPPED_ZERO_GROUPS = 5;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const HEX_RADIX = 16;

export interface ClientIpOptions {
  /**
   * True only when the process runs behind the Vercel proxy (production and preview deployments).
   * Local development and tests pass false: the header is then client-controlled and ignored.
   */
  readonly trustVercelProxy: boolean;
}

/**
 * Returns the validated, canonical client IP, or null when it is unknown or untrusted. Callers
 * decide how to treat null (never fall back to another request header).
 */
export function resolveClientIp(
  request: Pick<Request, 'headers'>,
  options: ClientIpOptions,
): string | null {
  if (!options.trustVercelProxy) return null;
  const raw = ipAddress(request.headers);
  return raw === undefined ? null : normalizeIp(raw);
}

/**
 * Validates a textual IP and returns its canonical form: IPv4 dotted-quad, IPv6 lowercase
 * RFC 5952, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) unwrapped to IPv4. Returns null for anything else
 * (lists, ports, zone ids, whitespace, hostnames).
 */
export function normalizeIp(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_IP_TEXT_LENGTH) return null;
  const family = isIP(raw);
  if (family === 4) return raw;
  if (family !== 6 || raw.includes('%')) return null;
  const groups = expandIpv6(raw);
  if (groups === null) return null;
  const mapped = unwrapIpv4Mapped(groups);
  return mapped ?? formatIpv6(groups);
}

/**
 * Identity used for per-IP rate limiting. IPv4 is used as is; IPv6 collapses to its /64 prefix,
 * otherwise a client owning a single /64 (2^64 addresses) could rotate source addresses to dodge
 * the limit. The input is normalized first, so every textual form of one address maps to one subject.
 */
export function rateLimitSubject(ip: string): string {
  const normalized = normalizeIp(ip) ?? ip;
  if (isIP(normalized) !== 6) return normalized;
  const groups = expandIpv6(normalized);
  if (groups === null) return normalized;
  const prefix = groups.slice(0, IPV6_RATE_LIMIT_PREFIX_GROUPS).map(toHex).join(':');
  return `${prefix}::/${IPV6_RATE_LIMIT_PREFIX_GROUPS * IPV6_GROUP_BITS}`;
}

const toHex = (group: number): string => group.toString(HEX_RADIX);

/** Expands any valid IPv6 text (compressed, mixed-case, IPv4 tail) into its 8 groups. */
function expandIpv6(text: string): readonly number[] | null {
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  const withoutIpv4Tail = tail.includes('.')
    ? replaceIpv4Tail(text.slice(0, lastColon + 1), tail)
    : text;
  if (withoutIpv4Tail === null) return null;

  const halves = withoutIpv4Tail.split('::');
  if (halves.length > 2) return null;
  const [headText = '', tailText] = halves;
  const head = parseGroups(headText);
  const rest = tailText === undefined ? [] : parseGroups(tailText);
  if (head === null || rest === null) return null;

  if (halves.length === 1) return head.length === IPV6_GROUP_COUNT ? head : null;
  const missing = IPV6_GROUP_COUNT - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...rest];
}

function replaceIpv4Tail(prefix: string, ipv4: string): string | null {
  const octets = ipv4.split('.').map((octet) => Number.parseInt(octet, 10));
  const [a, b, c, d] = octets;
  if (
    octets.length !== 4 ||
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
  ) {
    return null;
  }
  const high = (a << BYTE_BITS) | b;
  const low = (c << BYTE_BITS) | d;
  return `${prefix}${toHex(high)}:${toHex(low)}`;
}

function parseGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups = part.split(':').map((group) => Number.parseInt(group, HEX_RADIX));
  return groups.some((group) => Number.isNaN(group)) ? null : groups;
}

function unwrapIpv4Mapped(groups: readonly number[]): string | null {
  const leadingZeros = groups.slice(0, IPV4_MAPPED_ZERO_GROUPS).every((group) => group === 0);
  const [, , , , , marker, high, low] = groups;
  if (!leadingZeros || marker !== IPV4_MAPPED_GROUP || high === undefined || low === undefined) {
    return null;
  }
  const octets = [high >> BYTE_BITS, high & BYTE_MASK, low >> BYTE_BITS, low & BYTE_MASK];
  return octets.join('.');
}

/** RFC 5952: lowercase hex, no leading zeros, longest run (≥ 2) of zero groups becomes `::`. */
function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  groups.forEach((group, index) => {
    if (group !== 0) {
      runStart = -1;
      return;
    }
    if (runStart === -1) runStart = index;
    const length = index - runStart + 1;
    if (length > bestLength) {
      bestStart = runStart;
      bestLength = length;
    }
  });
  if (bestLength < 2) return groups.map(toHex).join(':');
  const head = groups.slice(0, bestStart).map(toHex).join(':');
  const tail = groups
    .slice(bestStart + bestLength)
    .map(toHex)
    .join(':');
  return `${head}::${tail}`;
}
