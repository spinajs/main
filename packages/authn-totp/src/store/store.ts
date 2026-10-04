import type { IdentityRef } from '@spinajs/authn/contracts';

/** One MFA step of an identity as stored. */
export interface MfaRecord {
  /** Cipher text as `put` received it; stores never encrypt or decrypt. */
  readonly secretEnc: string;
  readonly keyId: string;
  readonly confirmedAt: Date | null;
  /** The last accepted time step. */
  readonly lastStep: number | null;
  readonly createdAt: Date;
}

/**
 * `authn_mfa` and `authn_recovery_code` behind `TotpMfaStep`. Apps register `DbMfaSecretStore` by importing
 * `@spinajs/authn-totp/db`; tests register `MemoryMfaSecretStore` as this class.
 */
export abstract class MfaSecretStore {
  abstract get(id: IdentityRef, step: string): Promise<MfaRecord | null>;
  /**
   * Inserts the step, or replaces it while unconfirmed: unconfirmed, no accepted time step, created now; true.
   * Never overwrites a confirmed step: false means a confirmed row exists and nothing changed.
   */
  abstract put(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<boolean>;
  /**
   * Sets `confirmedAt` (default now) on an unconfirmed step that holds `expectedSecretEnc` when one is given. True only
   * for the call that made this change; atomic, one conditional write.
   */
  abstract confirm(id: IdentityRef, step: string, at?: Date, expectedSecretEnc?: string): Promise<boolean>;
  /** True once per time step, never for a step at or below the last accepted one (SR-15); false without a row. */
  abstract acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean>;
  abstract remove(id: IdentityRef, step: string): Promise<void>;
  /** Voids the old set and stores SHA-256 hex of each code; empty or repeated codes throw. */
  abstract replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void>;
  /** Single use: true for exactly one caller. */
  abstract redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean>;
  /** Unused codes. */
  abstract countRecoveryCodes(id: IdentityRef): Promise<number>;
  abstract removeRecoveryCodes(id: IdentityRef): Promise<void>;
}
