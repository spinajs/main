import type { IdentityRef } from '../contracts/credentials.js';
import type { CredentialChange } from '../contracts/credential-bus.js';
import { principalKey } from '../contracts/principal.js';

/** The cache tag of one token or key. */
export function credentialTag(kind: 'token' | 'key', id: string): string {
  return `${kind}:${id}`;
}

/** The cache tag every cached credential of `identity` carries. */
export function identityTag(identity: IdentityRef): string {
  return `identity:${principalKey(identity)}`;
}

/** The tags a cache invalidates for `change`. */
export function credentialChangeTags(change: CredentialChange): string[] {
  return change.kind === 'identity' ? [identityTag(change.identity)] : [credentialTag(change.kind, change.id)];
}
