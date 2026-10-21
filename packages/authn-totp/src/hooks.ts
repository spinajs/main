// The augmentation below resolves '@spinajs/hooks' only when this file imports it.
import '@spinajs/hooks';
import type { AuthnContext, IdentityRef, MfaBeginResult, MfaConfirmResult, MfaDisableResult, MfaRegenerateResult, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';

/** Runs once the session is restored and found fresh where the method needs it. */
export interface MfaEnrolInput {
  readonly session: SessionHandle;
  readonly ctx: AuthnContext;
}

export interface MfaAdminResetInput {
  readonly actor: PrincipalRef;
  readonly target: IdentityRef;
  readonly ctx: AuthnContext;
}

type Failure<R> = Exclude<R, { ok: true }>;

/** No output carries the provisioning URI or a recovery code. */
export type MfaBeginOutput = Failure<MfaBeginResult> | { readonly ok: true };
export type MfaConfirmOutput = Failure<MfaConfirmResult> | { readonly ok: true };
export type MfaRegenerateOutput = Failure<MfaRegenerateResult> | { readonly ok: true };

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.mfa.enrol.begin': { input: MfaEnrolInput; output: MfaBeginOutput };
    'authn.mfa.enrol.confirm': { input: MfaEnrolInput; output: MfaConfirmOutput };
    'authn.mfa.disable': { input: MfaEnrolInput; output: MfaDisableResult };
    'authn.mfa.recovery.regenerate': { input: MfaEnrolInput; output: MfaRegenerateOutput };
    'authn.mfa.adminReset': { input: MfaAdminResetInput; output: { reset: boolean } };
  }
}
