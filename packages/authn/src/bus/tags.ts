import type { IdentityRef } from '../contracts/credentials.js';
import type { CredentialChange } from '../contracts/credential-bus.js';

/** The cache tag of one token or key. */
export function credentialTag(_kind: 'token' | 'key', _id: string): string {
  throw new Error('not implemented: credentialTag');
}

/** The cache tag every cached credential of `identity` carries. */
export function identityTag(_identity: IdentityRef): string {
  throw new Error('not implemented: identityTag');
}

/** The tags a cache invalidates for `change`. */
export function credentialChangeTags(_change: CredentialChange): string[] {
  throw new Error('not implemented: credentialChangeTags');
}
