import { beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_NOW,
  AUTH_NOW_SECONDS,
  ISSUER,
  JWKS_URL,
  SUPABASE_URL,
  USER_ID,
  createFakeJwksEndpoint,
  createTestKey,
  hs256WithPublicKey,
  mintToken,
  unsecuredToken,
  type FakeJwksEndpoint,
  type TestKey,
} from '#test/fakes/staff-auth.ts';
import {
  InvalidAccessTokenError,
  MAX_TOKEN_LENGTH,
  SigningKeysUnavailableError,
  createAccessTokenVerifier,
  createSupabaseKeySource,
  supabaseAuthEndpoints,
  type AccessTokenVerifier,
  type InvalidTokenReason,
} from './access-token-verifier.ts';

let es: TestKey;
let rs: TestKey;
let es384: TestKey;
let rs512: TestKey;
let stranger: TestKey;

beforeAll(async () => {
  es = await createTestKey('ES256', 'key-es256');
  rs = await createTestKey('RS256', 'key-rs256');
  es384 = await createTestKey('ES384', 'key-es384');
  rs512 = await createTestKey('RS512', 'key-rs512');
  // Same kid as the real ES256 key, but a different key pair: a forged signature.
  stranger = await createTestKey('ES256', 'key-es256');
});

function build(overrides: { timeoutMs?: number } = {}): {
  verifier: AccessTokenVerifier;
  endpoint: FakeJwksEndpoint;
} {
  const endpoint = createFakeJwksEndpoint([
    es.publicJwk,
    rs.publicJwk,
    es384.publicJwk,
    rs512.publicJwk,
  ]);
  const keys = createSupabaseKeySource(new URL(JWKS_URL), {
    fetch: endpoint.fetch,
    ...overrides,
  });
  return {
    verifier: createAccessTokenVerifier({ issuer: ISSUER, keys, now: () => AUTH_NOW }),
    endpoint,
  };
}

async function reasonOf(verifier: AccessTokenVerifier, token: string): Promise<InvalidTokenReason> {
  try {
    await verifier.verify(token);
  } catch (error) {
    if (error instanceof InvalidAccessTokenError) return error.reason;
    throw error;
  }
  throw new Error('expected the token to be rejected');
}

describe('supabaseAuthEndpoints', () => {
  it('derives issuer and JWKS URL from SUPABASE_URL (trailing slash and path ignored)', () => {
    expect(supabaseAuthEndpoints(SUPABASE_URL)).toEqual({
      issuer: ISSUER,
      jwksUrl: new URL(JWKS_URL),
    });
    expect(supabaseAuthEndpoints(`${SUPABASE_URL}/`).issuer).toBe(ISSUER);
  });
});

describe('access token verification: accepted tokens', () => {
  it('accepts a valid ES256 token and exposes only the verified facts', async () => {
    const { verifier } = build();
    const token = await mintToken({ key: es });

    const verified = await verifier.verify(token);

    expect(verified).toEqual({
      userId: USER_ID,
      email: 'vendedora@empresa.com.br',
      aal: 'aal1',
      mfaVerifiedAt: null,
      sessionId: '0196f1a0-cccc-4000-8000-000000000001',
    });
  });

  it('accepts a valid RS256 token', async () => {
    const { verifier } = build();
    await expect(verifier.verify(await mintToken({ key: rs }))).resolves.toMatchObject({
      userId: USER_ID,
    });
  });

  it('accepts an audience list that contains "authenticated"', async () => {
    const { verifier } = build();
    const token = await mintToken({ key: es, claims: { aud: ['authenticated', 'other'] } });
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });

  it('tolerates 5 seconds of clock skew on exp and nbf', async () => {
    const { verifier } = build();
    const justExpired = await mintToken({ key: es, claims: { exp: AUTH_NOW_SECONDS - 4 } });
    const almostValid = await mintToken({ key: es, claims: { nbf: AUTH_NOW_SECONDS + 4 } });
    await expect(verifier.verify(justExpired)).resolves.toBeDefined();
    await expect(verifier.verify(almostValid)).resolves.toBeDefined();
  });

  it('ignores jku, jwk and x5u in the header: keys come only from the configured JWKS (ST-04)', async () => {
    const { verifier, endpoint } = build();
    const token = await mintToken({
      key: es,
      header: {
        jku: 'https://evil.example/jwks.json',
        jwk: stranger.publicJwk,
        x5u: 'https://evil.example/cert.pem',
      },
    });

    await expect(verifier.verify(token)).resolves.toBeDefined();
    expect(endpoint.calls).toEqual([JWKS_URL]);
  });
});

describe('access token verification: algorithm confusion (ST-01)', () => {
  it('rejects alg none and never asks for a key', async () => {
    const { verifier, endpoint } = build();
    expect(await reasonOf(verifier, unsecuredToken())).toBe('algorithm');
    expect(endpoint.calls).toHaveLength(0);
  });

  it('rejects HS256 signed with the public key as secret', async () => {
    const { verifier, endpoint } = build();
    expect(await reasonOf(verifier, await hs256WithPublicKey(es))).toBe('algorithm');
    expect(endpoint.calls).toHaveLength(0);
  });

  it('rejects ES384 and RS512 even with a valid signature from a published key', async () => {
    const { verifier } = build();
    expect(await reasonOf(verifier, await mintToken({ key: es384 }))).toBe('algorithm');
    expect(await reasonOf(verifier, await mintToken({ key: rs512 }))).toBe('algorithm');
  });

  it('rejects an alg header that does not match the key type of the kid', async () => {
    const { verifier } = build();
    // Signed by the RSA key but announcing ES256 with the EC key id.
    const token = await mintToken({ key: { ...rs, alg: 'RS256' }, kid: es.kid });
    expect(['signature', 'key_not_found']).toContain(await reasonOf(verifier, token));
  });

  it('rejects a signature made by a different key under a known kid', async () => {
    const { verifier } = build();
    expect(await reasonOf(verifier, await mintToken({ key: stranger }))).toBe('signature');
  });
});

describe('access token verification: identity claims (ST-02)', () => {
  it.each<[string, Record<string, unknown>, InvalidTokenReason]>([
    ['wrong issuer', { iss: 'https://other-project.supabase.co/auth/v1' }, 'issuer'],
    ['missing issuer', { iss: undefined }, 'issuer'],
    ['wrong audience', { aud: 'anon' }, 'audience'],
    ['service_role token', { role: 'service_role' }, 'claims'],
    ['anon token', { role: 'anon' }, 'claims'],
    ['anonymous account', { is_anonymous: true }, 'not_staff_account'],
    ['sub that is not a UUID', { sub: 'not-a-uuid' }, 'claims'],
    ['missing sub', { sub: undefined }, 'claims'],
    ['missing e-mail', { email: undefined }, 'claims'],
    ['aal outside aal1/aal2', { aal: 'aal3' }, 'claims'],
    ['amr that is not an array', { amr: 'totp' }, 'claims'],
    [
      'amr entry with a string timestamp',
      { amr: [{ method: 'totp', timestamp: 'now' }] },
      'claims',
    ],
  ])('rejects %s', async (_name, claims, reason) => {
    const { verifier } = build();
    expect(await reasonOf(verifier, await mintToken({ key: es, claims }))).toBe(reason);
  });
});

describe('access token verification: time window (ST-03)', () => {
  it.each<[string, Record<string, unknown>, InvalidTokenReason]>([
    ['expired beyond the tolerance', { exp: AUTH_NOW_SECONDS - 6 }, 'expired'],
    ['not yet valid (nbf in the future)', { nbf: AUTH_NOW_SECONDS + 30 }, 'not_yet_valid'],
    [
      'issued in the future',
      { iat: AUTH_NOW_SECONDS + 600, exp: AUTH_NOW_SECONDS + 900 },
      'not_yet_valid',
    ],
    [
      'lifetime above one hour',
      { iat: AUTH_NOW_SECONDS - 60, exp: AUTH_NOW_SECONDS - 60 + 3601 },
      'lifetime',
    ],
    ['missing exp', { exp: undefined }, 'claims'],
    ['missing iat', { iat: undefined }, 'claims'],
  ])('rejects a token %s', async (_name, claims, reason) => {
    const { verifier } = build();
    expect(await reasonOf(verifier, await mintToken({ key: es, claims }))).toBe(reason);
  });
});

describe('access token verification: malformed input', () => {
  it.each(['', 'abc', 'a.b', 'a.b.c', 'a.b.c.d.e', '....', '###.###.###'])(
    'rejects the garbled token %j',
    async (token) => {
      const { verifier } = build();
      expect(await reasonOf(verifier, token)).toBe('malformed');
    },
  );

  it('rejects a token above the size limit without parsing it', async () => {
    const { verifier, endpoint } = build();
    expect(await reasonOf(verifier, 'a'.repeat(MAX_TOKEN_LENGTH + 1))).toBe('malformed');
    expect(endpoint.calls).toHaveLength(0);
  });

  it('rejects a token with a valid header but a tampered payload', async () => {
    const { verifier } = build();
    const [header, , signature] = (await mintToken({ key: es })).split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: USER_ID, role: 'authenticated', aal: 'aal2' }),
    ).toString('base64url');
    expect(await reasonOf(verifier, `${header}.${forgedPayload}.${signature}`)).toBe('signature');
  });
});

describe('access token verification: assurance and MFA (C10-C12)', () => {
  const nowMinus = (seconds: number): number => AUTH_NOW_SECONDS - seconds;

  it('reads aal2 and the latest TOTP verification from amr', async () => {
    const { verifier } = build();
    const token = await mintToken({
      key: es,
      claims: {
        aal: 'aal2',
        amr: [
          { method: 'totp', timestamp: nowMinus(120) },
          { method: 'password', timestamp: nowMinus(600) },
        ],
      },
    });

    const verified = await verifier.verify(token);

    expect(verified.aal).toBe('aal2');
    expect(verified.mfaVerifiedAt).toEqual(new Date((AUTH_NOW_SECONDS - 120) * 1000));
  });

  it('ignores non-MFA methods even when they are the most recent (a refresh is not a second factor)', async () => {
    const { verifier } = build();
    const token = await mintToken({
      key: es,
      claims: {
        aal: 'aal2',
        amr: [
          { method: 'token_refresh', timestamp: nowMinus(5) },
          { method: 'password', timestamp: nowMinus(10) },
          { method: 'totp', timestamp: nowMinus(200) },
        ],
      },
    });
    expect((await verifier.verify(token)).mfaVerifiedAt).toEqual(
      new Date((AUTH_NOW_SECONDS - 200) * 1000),
    );
  });

  it('picks the newest of several MFA entries', async () => {
    const { verifier } = build();
    const token = await mintToken({
      key: es,
      claims: {
        aal: 'aal2',
        amr: [
          { method: 'mfa/phone', timestamp: nowMinus(300) },
          { method: 'totp', timestamp: nowMinus(30) },
        ],
      },
    });
    expect((await verifier.verify(token)).mfaVerifiedAt).toEqual(
      new Date((AUTH_NOW_SECONDS - 30) * 1000),
    );
  });

  it('reports no MFA timestamp for aal2 without an MFA entry (the guard then denies it)', async () => {
    const { verifier } = build();
    const token = await mintToken({
      key: es,
      claims: { aal: 'aal2', amr: [{ method: 'password', timestamp: nowMinus(30) }] },
    });
    const verified = await verifier.verify(token);
    expect(verified.aal).toBe('aal2');
    expect(verified.mfaVerifiedAt).toBeNull();
  });

  it('treats a missing aal as aal1 and a missing amr as empty', async () => {
    const { verifier } = build();
    const token = await mintToken({ key: es, claims: { aal: undefined, amr: undefined } });
    expect(await verifier.verify(token)).toMatchObject({ aal: 'aal1', mfaVerifiedAt: null });
  });
});

describe('JWKS handling (ST-04, ST-05)', () => {
  it('rejects an unknown kid and does not refetch per request (cooldown)', async () => {
    const { verifier, endpoint } = build();
    const unknown = await mintToken({ key: es, kid: 'rotated-away' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await reasonOf(verifier, unknown)).toBe('key_not_found');
    }

    expect(endpoint.calls).toHaveLength(1);
  });

  it('answers 503-class when the JWKS is down and nothing is cached', async () => {
    const { verifier, endpoint } = build();
    endpoint.mode = 'down';
    await expect(verifier.verify(await mintToken({ key: es }))).rejects.toBeInstanceOf(
      SigningKeysUnavailableError,
    );
  });

  it.each(['not_found', 'redirect', 'malformed'] as const)(
    'fails closed on a JWKS endpoint that answers %s',
    async (mode) => {
      const { verifier, endpoint } = build();
      endpoint.mode = mode;
      await expect(verifier.verify(await mintToken({ key: es }))).rejects.toBeInstanceOf(
        SigningKeysUnavailableError,
      );
    },
  );

  it('fails closed when the JWKS endpoint is too slow', async () => {
    const { verifier, endpoint } = build({ timeoutMs: 1 });
    endpoint.mode = 'hang';
    await expect(verifier.verify(await mintToken({ key: es }))).rejects.toBeInstanceOf(
      SigningKeysUnavailableError,
    );
  });

  it('keeps serving from the cache while the JWKS is down', async () => {
    const { verifier, endpoint } = build();
    await verifier.verify(await mintToken({ key: es }));
    endpoint.mode = 'down';

    await expect(verifier.verify(await mintToken({ key: rs }))).resolves.toBeDefined();
    expect(endpoint.calls).toHaveLength(1);
  });

  it('rejects a key that is not in the JWKS even when the signature would verify with it', async () => {
    const { verifier } = build();
    const unpublished = await createTestKey('ES256', 'unpublished');
    expect(await reasonOf(verifier, await mintToken({ key: unpublished }))).toBe('key_not_found');
  });
});
