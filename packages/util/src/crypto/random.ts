import { randomBytes } from 'node:crypto';
import { InvalidArgument } from '@spinajs/exceptions';

let secret: Buffer | undefined;

/** `bytes` random bytes as unpadded base64url (default) or hex. */
export function randomToken(bytes = 32, enc: 'base64url' | 'hex' = 'base64url'): string {
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new InvalidArgument('bytes must be a positive integer', 'bytes');
  }
  if (enc !== 'base64url' && enc !== 'hex') {
    throw new InvalidArgument(`enc must be 'base64url' or 'hex'`, 'enc');
  }
  return randomBytes(bytes).toString(enc);
}

/**
 * A 32-byte random key made on first use and kept for the life of the process (of this module copy), for keying
 * in-process HMACs when no secret is configured. Each call returns a fresh copy, so a caller cannot change it for others.
 */
export function processSecret(): Buffer {
  secret ??= randomBytes(32);
  return Buffer.from(secret);
}
