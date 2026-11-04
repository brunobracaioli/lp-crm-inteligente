import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { Receiver } from '@upstash/qstash';
import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  QstashSignatureVerifier,
  type SignatureRejectionReason,
} from '#/modules/tracking/infrastructure/qstash-signature.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';

const CURRENT_KEY = 'test-current-signing-key-0001';
const NEXT_KEY = 'test-next-signing-key-0002';
const DISPATCH_URL = 'https://api.example.test/internal/v1/outbox/dispatch';
const BODY = '{"outbox_event_id":"0192f3a0-1111-7222-8333-444455556666"}';
const NOW_MS = Date.parse('2026-11-03T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const encoder = new TextEncoder();

interface TokenOptions {
  readonly key?: string;
  readonly alg?: string;
  readonly iss?: string;
  readonly sub?: string;
  readonly body?: string;
  /** Overrides the `body` claim verbatim (e.g. to test padding or a wrong hash). */
  readonly bodyClaim?: string | undefined;
  readonly nbf?: number | null;
  readonly exp?: number | null;
}

const bodyHash = (body: string) => createHash('sha256').update(body, 'utf8').digest('base64url');

/** Builds a token shaped like QStash's: iss, sub, exp, nbf, iat, jti and the body hash. */
async function signToken(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { jti: 'jwt_test_1' };
  if (!('bodyClaim' in options && options.bodyClaim === undefined)) {
    claims.body = options.bodyClaim ?? bodyHash(options.body ?? BODY);
  }
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? 'HS256' })
    .setIssuer(options.iss ?? 'Upstash')
    .setSubject(options.sub ?? DISPATCH_URL)
    .setIssuedAt(NOW_S);
  if (options.nbf !== null) jwt.setNotBefore(options.nbf ?? NOW_S);
  if (options.exp !== null) jwt.setExpirationTime(options.exp ?? NOW_S + 300);
  return jwt.sign(encoder.encode(options.key ?? CURRENT_KEY));
}

function newVerifier(clockMs: number = NOW_MS) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const metrics = createRecordingMetrics();
  const verifier = new QstashSignatureVerifier(
    { currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY },
    {
      clock: { now: () => new Date(clockMs) },
      logger: createLogger({ level: 'debug', appEnv: 'test', destination }),
      metrics,
    },
  );
  return { verifier, metrics, lines };
}

async function verify(
  signature: string | null,
  overrides: { rawBody?: string; url?: string; clockMs?: number } = {},
) {
  const { verifier, metrics, lines } = newVerifier(overrides.clockMs);
  const accepted = await verifier.verify({
    signature,
    rawBody: overrides.rawBody ?? BODY,
    url: overrides.url ?? DISPATCH_URL,
  });
  return { accepted, metrics, lines };
}

function lastReason(metrics: ReturnType<typeof createRecordingMetrics>) {
  return metrics.records.at(-1)?.attributes?.reason as SignatureRejectionReason | undefined;
}

describe('QstashSignatureVerifier acceptance', () => {
  it('accepts a valid token signed with the current key', async () => {
    const { accepted, metrics } = await verify(await signToken());

    expect(accepted).toBe(true);
    expect(metrics.records).toEqual([]);
  });

  it('accepts a valid token signed with the next key (rotation)', async () => {
    expect((await verify(await signToken({ key: NEXT_KEY }))).accepted).toBe(true);
  });

  it('accepts a body claim with trailing base64 padding, like the QStash SDK', async () => {
    expect((await verify(await signToken({ bodyClaim: `${bodyHash(BODY)}=` }))).accepted).toBe(
      true,
    );
  });

  it('accepts exp/nbf inside the clock tolerance and rejects them outside it', async () => {
    const expiredByThree = await signToken({ exp: NOW_S - 3 });
    const expiredBySix = await signToken({ exp: NOW_S - 6 });
    const startsInThree = await signToken({ nbf: NOW_S + 3 });
    const startsInSix = await signToken({ nbf: NOW_S + 6 });

    expect((await verify(expiredByThree)).accepted).toBe(true);
    expect((await verify(startsInThree)).accepted).toBe(true);
    expect((await verify(expiredBySix)).accepted).toBe(false);
    expect((await verify(startsInSix)).accepted).toBe(false);
  });
});

describe('AC-TR-03 unauthenticated dispatch is rejected', () => {
  it.each([null, ''])('AC-TR-03: rejects a request without signature (%j)', async (signature) => {
    const { accepted, metrics } = await verify(signature);

    expect(accepted).toBe(false);
    expect(lastReason(metrics)).toBe('missing_signature');
  });

  it('AC-TR-03: rejects a valid signature presented with a different body', async () => {
    const signature = await signToken();

    const other = await verify(signature, {
      rawBody: '{"outbox_event_id":"11111111-1111-7111-8111-111111111111"}',
    });

    expect(other.accepted).toBe(false);
    expect(lastReason(other.metrics)).toBe('body_mismatch');
  });

  it('AC-TR-03: hashes the raw body, so re-serialized JSON with the same meaning is rejected', async () => {
    const signature = await signToken();

    const spaced = await verify(signature, { rawBody: BODY.replace(':', ': ') });

    expect(spaced.accepted).toBe(false);
    expect(lastReason(spaced.metrics)).toBe('body_mismatch');
  });

  it('AC-TR-03: rejects an expired signature', async () => {
    const signature = await signToken({ exp: NOW_S + 300 });

    const later = await verify(signature, { clockMs: NOW_MS + 306_000 });

    expect(later.accepted).toBe(false);
    expect(lastReason(later.metrics)).toBe('expired');
  });

  it('AC-TR-03: rejects a token that is not valid yet (nbf in the future)', async () => {
    const { accepted, metrics } = await verify(await signToken({ nbf: NOW_S + 60 }));

    expect(accepted).toBe(false);
    expect(lastReason(metrics)).toBe('not_yet_valid');
  });

  it('AC-TR-03: rejects a token issued for another URL (sub mismatch)', async () => {
    const signature = await signToken();

    for (const url of [
      'https://api.example.test/internal/v1/outbox/sweep',
      `${DISPATCH_URL}?x=1`,
      'https://evil.example.test/internal/v1/outbox/dispatch',
    ]) {
      const result = await verify(signature, { url });
      expect(result.accepted).toBe(false);
      expect(lastReason(result.metrics)).toBe('url_mismatch');
    }
  });

  it('AC-TR-03: rejects a token signed with an unknown key', async () => {
    const { accepted, metrics } = await verify(await signToken({ key: 'attacker-key' }));

    expect(accepted).toBe(false);
    expect(lastReason(metrics)).toBe('bad_signature');
  });

  it('AC-TR-03: rejects a wrong issuer', async () => {
    const { accepted, metrics } = await verify(await signToken({ iss: 'Mallory' }));

    expect(accepted).toBe(false);
    expect(lastReason(metrics)).toBe('bad_issuer');
  });

  it('AC-TR-03: rejects algorithms other than HS256, even with the right key', async () => {
    const { accepted, metrics } = await verify(await signToken({ alg: 'HS512' }));

    expect(accepted).toBe(false);
    expect(lastReason(metrics)).toBe('bad_algorithm');
  });

  it('AC-TR-03: rejects an unsigned (alg none) token', async () => {
    const unsigned = new UnsecuredJWT({ body: bodyHash(BODY) })
      .setIssuer('Upstash')
      .setSubject(DISPATCH_URL)
      .setExpirationTime(NOW_S + 300)
      .setNotBefore(NOW_S)
      .encode();

    expect((await verify(unsigned)).accepted).toBe(false);
  });

  it.each([
    ['without exp', { exp: null }],
    ['without nbf', { nbf: null }],
    ['without body', { bodyClaim: undefined }],
  ] as const)('AC-TR-03: rejects a token %s', async (_label, options) => {
    const { accepted, metrics } = await verify(await signToken(options));

    expect(accepted).toBe(false);
    expect(lastReason(metrics)).toBe('missing_claim');
  });

  it('AC-TR-03: rejects a non-string or wrong body claim', async () => {
    expect((await verify(await signToken({ bodyClaim: 'not-the-hash' }))).accepted).toBe(false);
  });

  it.each(['garbage', 'a.b.c', 'x'.repeat(5000), '..', `e30.e30.`])(
    'AC-TR-03: rejects a malformed signature header (%#)',
    async (signature) => {
      const { accepted, metrics } = await verify(signature);

      expect(accepted).toBe(false);
      expect(lastReason(metrics)).toBe('malformed');
    },
  );

  it('records a metric and a warn log per rejection without leaking the token or the body', async () => {
    const signature = await signToken({ key: 'attacker-key' });

    const { metrics, lines } = await verify(signature);

    expect(metrics.records).toEqual([
      { name: 'auth.qstash_signature_invalid', value: 1, attributes: { reason: 'bad_signature' } },
    ]);
    const output = lines.join('');
    expect(output).toContain('"level":"warn"');
    expect(output).toContain('bad_signature');
    expect(output).not.toContain(signature);
    expect(output).not.toContain(CURRENT_KEY);
    expect(output).not.toContain('outbox_event_id');
  });
});

describe('parity with the official @upstash/qstash Receiver', () => {
  /** The Receiver reads the real clock, so these tokens are built around the real "now". */
  async function realTimeToken(options: Omit<TokenOptions, 'nbf' | 'exp'> = {}): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return signToken({ ...options, nbf: nowSeconds - 1, exp: nowSeconds + 300 });
  }

  const receiver = new Receiver({ currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });

  async function receiverAccepts(signature: string, rawBody: string, url: string) {
    try {
      return await receiver.verify({ signature, body: rawBody, url });
    } catch {
      return false;
    }
  }

  it.each([
    ['current key', {}, BODY, DISPATCH_URL],
    ['next key', { key: NEXT_KEY }, BODY, DISPATCH_URL],
    ['unknown key', { key: 'attacker-key' }, BODY, DISPATCH_URL],
    ['other body', {}, '{"outbox_event_id":"x"}', DISPATCH_URL],
    ['other url', {}, BODY, 'https://api.example.test/internal/v1/outbox/sweep'],
    ['wrong issuer', { iss: 'Mallory' }, BODY, DISPATCH_URL],
  ] as const)('reaches the same verdict for: %s', async (_label, options, rawBody, url) => {
    const signature = await realTimeToken(options);
    const { verifier } = newVerifier(Date.now());

    const ours = await verifier.verify({ signature, rawBody, url });

    expect(ours).toBe(await receiverAccepts(signature, rawBody, url));
  });
});

describe('QstashSignatureVerifier config', () => {
  it('refuses empty signing keys', () => {
    const deps = newVerifier();
    expect(
      () =>
        new QstashSignatureVerifier(
          { currentSigningKey: '', nextSigningKey: NEXT_KEY },
          {
            clock: { now: () => new Date(NOW_MS) },
            logger: createLogger({ level: 'silent', appEnv: 'test' }),
            metrics: deps.metrics,
          },
        ),
    ).toThrow(/signing keys must not be empty/);
  });
});
