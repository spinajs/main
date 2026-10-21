import type { IdentityRef } from './credentials.js';

/** Single-use secrets: reset, invite, email confirm, key challenge. Stored as SHA-256 only (SR-09); DbSecretStore in authn-orm. */
export abstract class SecretStore {
  /**
   * Returns the raw secret once (≥ 128 bits); replaces older ones of that purpose (A11). `value` makes the secret that string
   * instead, for short codes whose guessing the caller limits itself; a store that cannot keep it returns a random one.
   */
  abstract issue(identity: IdentityRef, purpose: string, ttlSeconds: number, value?: string): Promise<string>;
  /** Constant time; single use; false for a wrong, expired, redeemed or other-purpose secret (A11). */
  abstract redeem(identity: IdentityRef, purpose: string, raw: string): Promise<boolean>;
}
