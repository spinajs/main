import type { IdentityRef } from './credentials.js';

/** Single-use secrets: reset, invite, email confirm, key challenge. Stored as SHA-256 only (SR-09); DbSecretStore in authn-orm. */
export abstract class SecretStore {
  /** Returns the raw secret once (≥ 128 bits); replaces older ones of that purpose (A11). */
  abstract issue(identity: IdentityRef, purpose: string, ttlSeconds: number): Promise<string>;
  /** Constant time; single use; false for a wrong, expired, redeemed or other-purpose secret (A11). */
  abstract redeem(identity: IdentityRef, purpose: string, raw: string): Promise<boolean>;
}
