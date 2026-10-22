// The augmentation below resolves '@spinajs/hooks' only when this file imports it.
import '@spinajs/hooks';
import type { AuthnContext, IdentityRef, KeyRegisterResult, KeyRegistration, PrincipalRef } from '@spinajs/authn/contracts';

/** Runs after the key, its proof and the actor are checked. */
export interface KeyRegisterInput {
  readonly reg: KeyRegistration;
  readonly ctx: AuthnContext;
}

export interface KeyRevokeInput {
  readonly owner: IdentityRef;
  readonly kid: string;
  readonly actor?: PrincipalRef;
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.key.register': { input: KeyRegisterInput; output: KeyRegisterResult };
    'authn.key.revoke': { input: KeyRevokeInput; output: boolean };
  }
}
