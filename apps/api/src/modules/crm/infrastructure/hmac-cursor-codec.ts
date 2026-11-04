import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  CursorCodec,
  CursorScope,
  KeysetPosition,
} from '#/modules/crm/application/queries/ports.ts';
import type { Clock } from '#/shared/time.ts';

/** Keyed MAC of `createKeyedMac(pepper, 'crm-cursor-v1')`: base64url, deterministic. */
export type CursorMac = (value: string) => string;

/** A cursor lives long enough to page through a list, short enough to limit replay. */
export const DEFAULT_CURSOR_TTL_SECONDS = 60 * 60;

export interface HmacCursorCodecOptions {
  readonly mac: CursorMac;
  readonly clock: Pick<Clock, 'now'>;
  readonly ttlSeconds?: number;
}

const MS_PER_SECOND = 1000;
const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Payload of the token: the keyset position and the expiry. Scope is bound through the MAC only. */
const payloadSchema = z.strictObject({
  c: z.string().regex(MICROSECOND_INSTANT),
  i: z.guid(),
  e: z.number().int().positive(),
});

function scopeString(scope: CursorScope): string {
  return JSON.stringify([scope.kind, scope.workspaceId, scope.userId, scope.subject]);
}

function macOver(mac: CursorMac, payload: string, scope: CursorScope): string {
  return mac(`${payload}\n${scopeString(scope)}`);
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parsePayload(encoded: string): z.infer<typeof payloadSchema> | null {
  try {
    const parsed = payloadSchema.safeParse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Opaque, signed keyset cursor (threat model C20, ST-34): `base64url(payload) "." mac`. The MAC
 * covers the payload AND the scope (kind, workspace, user, filter fingerprint or lead id), which is
 * not stored in the token — a cursor therefore cannot be replayed by another user, against another
 * workspace or lead, or with other filters, and the search term never appears in it. The position is
 * re-validated (UUID, microsecond timestamp) after the MAC check and is only ever sent to the
 * database as a bound parameter.
 */
export function createHmacCursorCodec(options: HmacCursorCodecOptions): CursorCodec {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_CURSOR_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError('ttlSeconds must be a positive integer');
  }

  return {
    encode(scope: CursorScope, position: KeysetPosition): string {
      const expiresAt = Math.floor(options.clock.now().getTime() / MS_PER_SECOND) + ttlSeconds;
      const payload = Buffer.from(
        JSON.stringify({ c: position.createdAt, i: position.id, e: expiresAt }),
        'utf8',
      ).toString('base64url');
      return `${payload}.${macOver(options.mac, payload, scope)}`;
    },

    decode(scope: CursorScope, token: string): KeysetPosition | null {
      const parts = token.split('.');
      const [payload, signature] = parts;
      if (parts.length !== 2 || payload === undefined || signature === undefined) {
        return null;
      }
      if (!constantTimeEquals(signature, macOver(options.mac, payload, scope))) {
        return null;
      }
      const content = parsePayload(payload);
      if (content === null) {
        return null;
      }
      if (content.e <= Math.floor(options.clock.now().getTime() / MS_PER_SECOND)) {
        return null;
      }
      return { createdAt: content.c, id: content.i.toLowerCase() };
    },
  };
}
