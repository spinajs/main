import { AsyncService } from '@spinajs/di';
import type { AuthnContext, Credentials, IdentityRef } from './credentials.js';
import type { AuthnFacts, PrincipalRef } from './principal.js';
import type { SessionHandle } from './session.js';

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

/**
 * DefaultMfaPolicy: required when enrolled; 'force' makes enrolment mandatory. An AsyncService so an implementation can
 * check its setup and list its steps in `resolve()`; ConfiguredMfaPolicy lists those of `authn.mfa.steps`.
 */
export abstract class MfaPolicy extends AsyncService {
  /** The steps by name, in list order; login, completeMfa and the enrolment routes take them from the configured policy. */
  abstract steps(): Promise<ReadonlyMap<string, MfaStep>>;
  /** Names of the steps still to pass; empty: no MFA for this login. */
  abstract required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]>;
}

export type MfaBeginResult = { readonly ok: true; readonly provisioning: string } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'enrolled' };
/** `enrolled`: already enrolled, another confirmation won, or the codes could not be issued; the owner regenerates the codes. */
export type MfaConfirmResult = { readonly ok: true; readonly recoveryCodes: readonly string[] } | { readonly ok: false; readonly code: 'no_session' | 'not_begun' | 'invalid_code' | 'enrolled' | 'throttled'; readonly retryAfterSeconds?: number };
export type MfaDisableResult = { readonly ok: true } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'not_enrolled' | 'invalid_code' | 'throttled'; readonly retryAfterSeconds?: number };
export type MfaRegenerateResult = { readonly ok: true; readonly recoveryCodes: readonly string[] } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'not_enrolled' };

/**
 * The owner's enrolment in one MFA step and the admin reset of it, behind the 3.0 enrolment routes and the admin
 * mfa-reset route; TotpService in authn-totp. The owner methods act on the identity of the restored session, never on
 * one the caller names; refusals are results, not exceptions.
 */
export abstract class MfaEnrolmentService {
  /** True while login asks for this service's step: `steps` (the configured MfaPolicy's) lists it and it can store its secrets. */
  abstract enabled(steps: Iterable<MfaStep>): boolean;
  /** Needs fresh auth or `reauth` (A13). */
  abstract begin(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<MfaBeginResult>;
  abstract confirm(session: SessionHandle, code: string, ctx: AuthnContext): Promise<MfaConfirmResult>;
  /** `code` is a step code or a recovery code; needs fresh auth or `reauth` (A13). */
  abstract disable(session: SessionHandle, code: string, ctx: AuthnContext, reauth?: Credentials): Promise<MfaDisableResult>;
  /** Needs fresh auth or `reauth` (A13). */
  abstract regenerateRecoveryCodes(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<MfaRegenerateResult>;
  /** The caller applies the target guard (A25) first; never returns a secret (SR-10). `reset`: an enrolment or a pending one existed. */
  abstract adminReset(actor: PrincipalRef, target: IdentityRef, ctx: AuthnContext): Promise<{ reset: boolean }>;
}
