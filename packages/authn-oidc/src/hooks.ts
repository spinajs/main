import type {} from '@spinajs/hooks';
import type { AuthnContext } from '@spinajs/authn/contracts';

/** `authn.logout.backchannel`: a validated logout token, before its sessions are revoked. Not refusable: the IdP ended the session. */
export interface AuthnLogoutBackchannelInput {
  /** The strategy name the sessions carry in `AuthnFacts.external.provider`, e.g. `oidc:corp`. */
  readonly provider: string;
  /** The IdP session id; absent when the token names only a subject, whose identity then loses every session. */
  readonly sid?: string;
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.logout.backchannel': { input: AuthnLogoutBackchannelInput; output: void };
  }
}
