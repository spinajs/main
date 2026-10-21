// The augmentation below resolves '@spinajs/hooks' only when this file imports it.
import '@spinajs/hooks';
import type { AddressVerificationRequestResult, AddressVerificationResult, AuthnContext, IdentityRef, PasswordChangeResult, PasswordExpiry, PasswordResetRequestResult, PasswordResetResult, PasswordSetResult, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';

/** Passwords and secrets never reach a hook: no input carries one, and the change output leaves out the rotated session. */
export interface PasswordChangeInput {
  readonly id: IdentityRef;
  readonly session: SessionHandle;
  readonly ctx: AuthnContext;
}

export type PasswordChangeOutput = Exclude<PasswordChangeResult, { status: 'changed' }> | { readonly status: 'changed' };

export interface PasswordSetInput {
  readonly id: IdentityRef;
  readonly actor?: PrincipalRef;
  readonly ctx: AuthnContext;
}

/** Runs before the account is looked up, so a hook cannot tell a known login from an unknown one. */
export interface PasswordLoginInput {
  readonly login: string;
  readonly ctx: AuthnContext;
}

export interface PasswordInviteInput {
  readonly id: IdentityRef;
  readonly actor?: PrincipalRef;
  readonly ctx: AuthnContext;
}

export interface PasswordExpireInput {
  readonly id: IdentityRef;
  readonly opts: PasswordExpiry;
  readonly ctx: AuthnContext;
}

export interface AddressVerifyRequestInput {
  readonly id: IdentityRef;
  readonly ctx: AuthnContext;
}

/** Runs before the secret is read, so it names no identity. */
export interface AddressVerifyInput {
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.password.change': { input: PasswordChangeInput; output: PasswordChangeOutput };
    'authn.password.set': { input: PasswordSetInput; output: PasswordSetResult };
    'authn.password.reset.request': { input: PasswordLoginInput; output: PasswordResetRequestResult };
    'authn.password.reset.redeem': { input: PasswordLoginInput; output: PasswordResetResult };
    'authn.password.invite': { input: PasswordInviteInput; output: void };
    /** Not refusable for `cause: 'aged'`. */
    'authn.password.expire': { input: PasswordExpireInput; output: void };
    'authn.address.verify.request': { input: AddressVerifyRequestInput; output: AddressVerificationRequestResult };
    'authn.address.verify': { input: AddressVerifyInput; output: AddressVerificationResult };
  }
}
