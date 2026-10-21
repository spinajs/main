import { InvalidArgument } from '@spinajs/exceptions';
import { identityKey } from '@spinajs/authn-orm/identity';

import type { WebAuthnCredential } from '../contracts.js';

/** WebAuthn caps credential ids at 1023 bytes, which base64url spells in 1364 characters. */
export const CREDENTIAL_ID_MAX = 1364;
export const NAME_MAX = 64;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function checkedCredentialId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > CREDENTIAL_ID_MAX || !BASE64URL.test(value)) {
    throw new InvalidArgument('a WebAuthn credential id is base64url of at most 1023 bytes');
  }
  return value;
}

export function checkedCounter(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) throw new InvalidArgument(`${what}: a signature counter is an unsigned 32-bit integer`);
  return value as number;
}

/** The credential as a store accepts it; anything malformed throws `InvalidArgument`. */
export function checkedCredential(c: WebAuthnCredential): WebAuthnCredential {
  checkedCredentialId(c?.credentialId);
  identityKey(c.identity);
  if (!(c.publicKey instanceof Uint8Array) || c.publicKey.length === 0) throw new InvalidArgument('a WebAuthn credential needs its public key');
  checkedCounter(c.counter, 'counter');
  if (!(c.createdAt instanceof Date) || !Number.isFinite(c.createdAt.getTime())) throw new InvalidArgument('a WebAuthn credential needs a valid createdAt');
  if (c.name !== undefined && (typeof c.name !== 'string' || [...c.name].length > NAME_MAX)) throw new InvalidArgument(`a WebAuthn credential name is at most ${NAME_MAX} characters`);
  return c;
}
