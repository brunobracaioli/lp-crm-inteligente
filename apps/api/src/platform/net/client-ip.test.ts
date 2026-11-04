import { describe, expect, it } from 'vitest';
import { normalizeIp, rateLimitSubject, resolveClientIp } from '#/platform/net/client-ip.ts';

const TRUSTED = { trustVercelProxy: true } as const;

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://api.example.test/v1/leads', { method: 'POST', headers });
}

describe('resolveClientIp', () => {
  it('returns the x-real-ip set by the Vercel proxy', () => {
    // arrange
    const request = requestWith({ 'x-real-ip': '203.0.113.7' });
    // act + assert
    expect(resolveClientIp(request, TRUSTED)).toBe('203.0.113.7');
  });

  it('ignores a client-supplied x-forwarded-for when x-real-ip is present', () => {
    const request = requestWith({
      'x-real-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.99, 203.0.113.7',
    });
    expect(resolveClientIp(request, TRUSTED)).toBe('203.0.113.7');
  });

  it.each(['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip'])(
    'never falls back to the client-controlled %s header',
    (header) => {
      const request = requestWith({ [header]: '198.51.100.99' });
      expect(resolveClientIp(request, TRUSTED)).toBeNull();
    },
  );

  it('returns null when the process does not run behind the Vercel proxy', () => {
    const request = requestWith({ 'x-real-ip': '203.0.113.7' });
    expect(resolveClientIp(request, { trustVercelProxy: false })).toBeNull();
  });

  it('returns null when x-real-ip is absent', () => {
    expect(resolveClientIp(requestWith({}), TRUSTED)).toBeNull();
  });

  it.each([
    '203.0.113.7, 198.51.100.1',
    '203.0.113.7:443',
    '203.0.113.7 198.51.100.1',
    '203.0.113.256',
    '203.0.113',
    '01.2.3.4',
    'localhost',
    'fe80::1%eth0',
    '[2001:db8::1]',
    '1'.repeat(64),
    "'; DROP TABLE leads;--",
  ])('rejects the malformed x-real-ip %j', (value) => {
    expect(resolveClientIp(requestWith({ 'x-real-ip': value }), TRUSTED)).toBeNull();
  });
});

describe('normalizeIp', () => {
  it('keeps a valid IPv4 address untouched', () => {
    expect(normalizeIp('198.51.100.20')).toBe('198.51.100.20');
  });

  it('lowercases and compresses IPv6 to the RFC 5952 form', () => {
    expect(normalizeIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(normalizeIp('2001:0db8:0000:0000:0000:ff00:0042:8329')).toBe('2001:db8::ff00:42:8329');
  });

  it('compresses only the longest zero run and never a single zero group', () => {
    expect(normalizeIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(normalizeIp('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
  });

  it('unwraps IPv4-mapped IPv6 so dual-stack peers share one identity', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });

  it('handles the loopback and unspecified IPv6 addresses', () => {
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('::')).toBe('::');
  });

  it('rejects empty and non-IP input', () => {
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('rateLimitSubject', () => {
  it('uses the IPv4 address as the subject', () => {
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses every address of one IPv6 /64 into the same subject', () => {
    // arrange
    const first = normalizeIp('2001:db8:aaaa:bbbb::1');
    const second = normalizeIp('2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff');
    // act + assert
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(rateLimitSubject(first ?? '')).toBe('2001:db8:aaaa:bbbb::/64');
    expect(rateLimitSubject(second ?? '')).toBe('2001:db8:aaaa:bbbb::/64');
  });

  it('keeps different /64 prefixes apart', () => {
    expect(rateLimitSubject('2001:db8:aaaa:bbbb::1')).not.toBe(
      rateLimitSubject('2001:db8:aaaa:bbbc::1'),
    );
  });

  it('maps every textual form of one address to the same subject', () => {
    expect(rateLimitSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSubject('2001:DB8:AAAA:BBBB:0:0:0:1')).toBe(
      rateLimitSubject('2001:db8:aaaa:bbbb::1'),
    );
  });
});
