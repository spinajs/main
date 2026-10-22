// The augmentation below resolves '@spinajs/hooks' only when this file imports it.
import '@spinajs/hooks';
import type { AuthnContext, IdentityRef, PasskeyRegisterResult } from '@spinajs/authn/contracts';

/**
 * `identity` is the caller's own (the passkey routes act only on the session's identity); `ctx.session` is its session.
 * Registration runs once the attestation verifies, so `credentialId` is known.
 */
export interface PasskeyActionInput {
  readonly identity: IdentityRef;
  readonly credentialId?: string;
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.passkey.register': { input: PasskeyActionInput; output: PasskeyRegisterResult };
    'authn.passkey.revoke': { input: PasskeyActionInput; output: boolean };
  }
}
