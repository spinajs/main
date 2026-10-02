import type { IdentityRef } from './credentials.js';
import type { AuthnFacts } from './principal.js';

/** TotpMfaStep in authn-totp; later WebAuthn, email code. */
export abstract class MfaStep {
  /** 'totp' */
  abstract readonly name: string;
  abstract enrolled(id: IdentityRef): Promise<boolean>;
  /** Shown to the owner only. The caller requires fresh auth first (A10). */
  abstract beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }>;
  /** Recovery codes are returned once, stored as SHA-256 and single use (A10). */
  abstract confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }>;
  /** Counts into the throttle via AuthnService (flow 'mfa'); a code (time step) is accepted once (A10). */
  abstract verify(id: IdentityRef, response: string): Promise<boolean>;
  /**
   * Owner: the caller checks fresh auth and a valid code or recovery code first.
   * Admin reset (target guard, A25) also lands here and never receives a secret (A10).
   */
  abstract disable(id: IdentityRef): Promise<void>;
}

/** DefaultMfaPolicy: required when enrolled; 'force' makes enrolment mandatory. */
export abstract class MfaPolicy {
  /** Names of the steps still to pass; empty: no MFA for this login. */
  abstract required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]>;
}
