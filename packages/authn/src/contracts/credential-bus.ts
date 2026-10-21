import type { IdentityRef } from './credentials.js';

/** A credential that changed: a revoked token or key, or an identity whose status or credentials changed. */
export type CredentialChange = { readonly kind: 'token' | 'key'; readonly id: string } | { readonly kind: 'identity'; readonly identity: IdentityRef };

/**
 * Tells credential caches that a credential changed, so they evict it before their TTL runs out. The default bus only
 * reaches the current process; other processes rely on the cache TTL (D9).
 */
export abstract class CredentialChangeBus {
  abstract publish(change: CredentialChange): Promise<void>;

  /** Returns the unsubscribe function. */
  abstract subscribe(listener: (change: CredentialChange) => void): () => void;
}
