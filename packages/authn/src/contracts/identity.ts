import type { ExternalSubject, IdentityRef } from './credentials.js';

export interface IdentityStatus {
  readonly exists: boolean;
  readonly active: boolean;
  readonly banned: boolean;
  readonly deleted: boolean;
  readonly invitePending?: boolean;
}

/** Implemented by @spinajs/users. */
export abstract class IdentityStore {
  /** Email or login name. */
  abstract findByLogin(login: string): Promise<IdentityRef | null>;
  abstract status(id: IdentityRef): Promise<IdentityStatus>;
  /** For mails and audit. */
  abstract display(id: IdentityRef): Promise<{ email?: string; name?: string }>;
  /** JIT provisioning for OIDC (LDAP, SAML later); used only when authn.linking.jit is on, which is off by default. */
  provision?(external: ExternalSubject): Promise<IdentityRef>;
}

/** Implemented by @spinajs/users. */
export abstract class PasswordCredentialStore {
  /** The stored hash, or null when the identity has no password. */
  abstract get(id: IdentityRef): Promise<string | null>;
  /**
   * Stores the hash, never a raw password: hashing is the strategy's job (A03). With `expected`, writes only when the stored
   * value is still `expected` (null: no password stored), as one atomic compare-and-set in the store, and answers whether it
   * wrote: a mismatch answers false and does not throw. With `expected` undefined or omitted, writes unconditionally and
   * answers true.
   */
  abstract set(id: IdentityRef, hash: string, expected?: string | null): Promise<boolean>;
}
