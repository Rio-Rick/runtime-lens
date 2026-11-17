import { randomBytes } from 'node:crypto';

/** A CSP nonce must be unguessable, so it comes from the CSPRNG, not `Math.random`. */
export function createNonce(): string {
  return randomBytes(16).toString('hex');
}
