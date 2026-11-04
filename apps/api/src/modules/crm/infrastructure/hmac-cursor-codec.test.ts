import { describe, expect, it } from 'vitest';
import type { CursorScope, KeysetPosition } from '#/modules/crm/application/queries/ports.ts';
import { createKeyedMac } from '#/platform/crypto/derived-key.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import { FakeClock } from '#test/fakes/clock.ts';
import { createHmacCursorCodec, DEFAULT_CURSOR_TTL_SECONDS } from './hmac-cursor-codec.ts';

const PEPPER = Buffer.alloc(32, 1).toString('base64');
const OTHER_PEPPER = Buffer.alloc(32, 2).toString('base64');
const SCOPE: CursorScope = {
  kind: 'leads',
  workspaceId: '0194f1c2-0000-7000-8000-00000000000a' as WorkspaceId,
  userId: '0194f1c2-1111-7000-8000-00000000000a' as UserId,
  subject: '[null,null,null,null]',
};
const POSITION: KeysetPosition = {
  createdAt: '2026-11-03T14:00:00.123456Z',
  id: '0194f1c2-aaaa-7000-8000-000000000001',
};

function build(pepper = PEPPER) {
  const clock = new FakeClock();
  const codec = createHmacCursorCodec({ mac: createKeyedMac(pepper, 'crm-cursor-v1'), clock });
  return { clock, codec };
}

describe('createHmacCursorCodec', () => {
  it('round-trips the position with microsecond precision', () => {
    const { codec } = build();

    expect(codec.decode(SCOPE, codec.encode(SCOPE, POSITION))).toEqual(POSITION);
  });

  it('fits the contract Cursor schema (opaque, URL-safe, ≤ 512 characters)', () => {
    const { codec } = build();

    const token = codec.encode(SCOPE, POSITION);

    expect(token).toMatch(/^[A-Za-z0-9_.~-]+$/);
    expect(token.length).toBeLessThanOrEqual(512);
  });

  it('does not put the scope (filters, search term) in the token', () => {
    const { codec } = build();
    const scope = { ...SCOPE, subject: 'secret-search-term@example.com' };

    const token = codec.encode(scope, POSITION);
    const [payload] = token.split('.');

    expect(Buffer.from(payload ?? '', 'base64url').toString('utf8')).not.toContain('secret');
    expect(token).not.toContain('secret');
  });

  it.each([
    ['another kind', { ...SCOPE, kind: 'activities' as const }],
    [
      'another workspace',
      { ...SCOPE, workspaceId: '0194f1c2-0000-7000-8000-00000000000b' as WorkspaceId },
    ],
    ['another user', { ...SCOPE, userId: '0194f1c2-1111-7000-8000-00000000000c' as UserId }],
    ['another subject', { ...SCOPE, subject: '["won",null,null,null]' }],
  ])('rejects a cursor presented under %s', (_name, scope) => {
    const { codec } = build();
    const token = codec.encode(SCOPE, POSITION);

    expect(codec.decode(scope, token)).toBeNull();
  });

  it('rejects a token signed under another pepper', () => {
    const forged = build(OTHER_PEPPER).codec.encode(SCOPE, POSITION);

    expect(build().codec.decode(SCOPE, forged)).toBeNull();
  });

  it('rejects a payload swapped under a valid signature', () => {
    const { codec } = build();
    const [, signature] = codec.encode(SCOPE, POSITION).split('.');
    const otherPayload = Buffer.from(
      JSON.stringify({ c: '2000-01-01T00:00:00.000000Z', i: POSITION.id, e: 9_999_999_999 }),
    ).toString('base64url');

    expect(codec.decode(SCOPE, `${otherPayload}.${signature ?? ''}`)).toBeNull();
  });

  it('expires after the TTL (injected clock, no sleeping)', () => {
    const { codec, clock } = build();
    const token = codec.encode(SCOPE, POSITION);

    clock.advance((DEFAULT_CURSOR_TTL_SECONDS - 1) * 1000);
    expect(codec.decode(SCOPE, token)).toEqual(POSITION);
    clock.advance(1000);
    expect(codec.decode(SCOPE, token)).toBeNull();
  });

  it.each(['', '.', 'a.b.c', 'abc', '.abc', 'abc.', 'é.é', '%00.%00'])(
    'rejects malformed token %j',
    (token) => {
      expect(build().codec.decode(SCOPE, token)).toBeNull();
    },
  );

  it('rejects a correctly signed payload whose position is not a UUID and microsecond instant', () => {
    const clock = new FakeClock();
    const mac = createKeyedMac(PEPPER, 'crm-cursor-v1');
    const codec = createHmacCursorCodec({ mac, clock });
    const sign = (content: unknown): string => {
      const payload = Buffer.from(JSON.stringify(content)).toString('base64url');
      return `${payload}.${mac(`${payload}\n${JSON.stringify([SCOPE.kind, SCOPE.workspaceId, SCOPE.userId, SCOPE.subject])}`)}`;
    };
    const exp = Math.floor(clock.now().getTime() / 1000) + 60;

    expect(codec.decode(SCOPE, sign({ c: POSITION.createdAt, i: POSITION.id, e: exp }))).toEqual(
      POSITION,
    );
    expect(
      codec.decode(SCOPE, sign({ c: POSITION.createdAt, i: "'; DROP TABLE x;--", e: exp })),
    ).toBeNull();
    expect(codec.decode(SCOPE, sign({ c: '2026-11-03', i: POSITION.id, e: exp }))).toBeNull();
    expect(
      codec.decode(SCOPE, sign({ c: POSITION.createdAt, i: POSITION.id, e: exp, x: 1 })),
    ).toBeNull();
  });

  it('refuses a non-positive TTL', () => {
    expect(() =>
      createHmacCursorCodec({
        mac: createKeyedMac(PEPPER, 'crm-cursor-v1'),
        clock: new FakeClock(),
        ttlSeconds: 0,
      }),
    ).toThrow(RangeError);
  });
});
