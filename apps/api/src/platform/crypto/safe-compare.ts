import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time equality of two text values (MACs, plan hashes). Strings of different length are
 * unequal without comparing bytes: the length of a MAC is public.
 */
export function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
