import type { IdentityRef } from '@spinajs/authn/contracts';

/**
 * Recovery codes of the WebAuthn step, stored as SHA-256 only. `DbWebAuthnRecoveryCodeStore` keeps them in authn-orm's
 * `authn_recovery_code`, one set per identity, which the TOTP step shares: confirming either step replaces the set.
 */
export abstract class WebAuthnRecoveryCodeStore {
  /** Voids the old set; empty or repeated codes throw. */
  abstract replace(id: IdentityRef, rawCodes: readonly string[]): Promise<void>;
  /** Single use: true for exactly one caller. */
  abstract redeem(id: IdentityRef, raw: string): Promise<boolean>;
  abstract remove(id: IdentityRef): Promise<void>;
}

export class MemoryWebAuthnRecoveryCodeStore extends WebAuthnRecoveryCodeStore {
  replace(_id: IdentityRef, _rawCodes: readonly string[]): Promise<void> {
    throw new Error('not implemented: MemoryWebAuthnRecoveryCodeStore.replace');
  }

  redeem(_id: IdentityRef, _raw: string): Promise<boolean> {
    throw new Error('not implemented: MemoryWebAuthnRecoveryCodeStore.redeem');
  }

  remove(_id: IdentityRef): Promise<void> {
    throw new Error('not implemented: MemoryWebAuthnRecoveryCodeStore.remove');
  }

  /** The stored hashes, for storage checks in tests. */
  hashes(_id: IdentityRef): readonly string[] {
    throw new Error('not implemented: MemoryWebAuthnRecoveryCodeStore.hashes');
  }
}
