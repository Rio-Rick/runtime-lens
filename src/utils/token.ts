import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of randomness, hex encoded; regenerated on every server start. */
export function createSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time comparison that never throws on length mismatch. */
export function tokensMatch(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length !== expected.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}
