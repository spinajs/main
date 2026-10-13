import { SyncService } from '@spinajs/di';
import type { IdentityRef } from './credentials.js';
import type { AuthnFacts } from './principal.js';

/** TotpMfaStep in authn-totp; later WebAuthn, email code. */
export abstract class MfaStep {
  /** e.g. 'totp'. 'recovery' is reserved: completeMfa's step for recovery codes. */
  abstract readonly name: string;
  /** True when the step keeps secrets (e.g. TOTP seeds); boot then requires `authn.mfa.encryptionKey.secret` outside development and test (A24). */
  readonly storesSecrets: boolean = false;
  abstract enrolled(id: IdentityRef): Promise<boolean>;
  /** Shown to the owner only. The caller requires fresh auth first (A10). */
  abstract beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }>;
  /** Recovery codes are returned once, stored as SHA-256 and single use (A10). */
  abstract confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }>;
  /** Takes a step code only, never a recovery code. Counts into the throttle via AuthnService (flow 'mfa'); a code (time step) is accepted once (A10). */
  abstract verify(id: IdentityRef, response: string): Promise<boolean>;
  /** For steps that issue recovery codes. Single use; counts into the throttle via AuthnService (flow 'mfa') (A10). */
  verifyRecovery?(id: IdentityRef, code: string): Promise<boolean>;
  /** /user/mfa/recovery-codes; the route requires fresh auth (A13). Returns the new codes once and voids the old ones (A10). */
  regenerateRecoveryCodes?(id: IdentityRef): Promise<readonly string[]>;
  /**
   * Owner: the caller checks fresh auth and a valid code or recovery code first.
   * Admin reset (target guard, A25) also lands here and never receives a secret (A10).
   */
  abstract disable(id: IdentityRef): Promise<void>;
}

/** DefaultMfaPolicy: required when enrolled; 'force' makes enrolment mandatory. A SyncService so an implementation can check its setup in `resolve()`. */
export abstract class MfaPolicy extends SyncService {
  /** Names of the steps still to pass; empty: no MFA for this login. */
  abstract required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]>;
}
