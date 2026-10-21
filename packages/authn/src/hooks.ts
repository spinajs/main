import type { AuthenticationResult, AuthnContext, Credentials, ExternalSubject, IdentityRef } from './contracts/credentials.js';
import type { SessionHandle } from './contracts/session.js';
import type { ImpersonationStart } from './impersonation/impersonation-service.js';
import type { LinkResult } from './link/account-link-service.js';
import type { ActionName } from '@spinajs/hooks';

/**
 * `authn.login`: `AuthnService.authenticate` of a login (not of a per-request credential), before the throttle
 * and every strategy. A hook here must not branch on whether the account exists: its refusal is fast, so the timing
 * would tell. Rules that need the account belong in `authn.login.identified`.
 */
export interface AuthnLoginInput {
  credentials: Credentials;
  readonly ctx: AuthnContext;
}

/** `authn.login.identified`: an interactive login whose identity is known and whose status allows it, before MFA and the session. */
export interface AuthnLoginIdentifiedInput {
  readonly identity: IdentityRef;
  /** The strategy's configured name, e.g. `local` or `oidc:<provider>`. */
  readonly strategy: string;
  readonly method: string;
  /** The mapped subject of an external login (OIDC), its claims included. */
  readonly external?: ExternalSubject;
  /** The strategy's attributes; they reach PrincipalFactory as `extra.attributes`, where a PrincipalAttributeProvider key wins. */
  attributes: Readonly<Record<string, unknown>>;
  readonly ctx: AuthnContext;
}

export interface AuthnMfaVerifyInput {
  readonly pending: SessionHandle;
  readonly step: string;
  readonly response: string;
  readonly ctx: AuthnContext;
}

export interface AuthnReauthInput {
  readonly session: SessionHandle;
  readonly credentials: Credentials;
  readonly ctx: AuthnContext;
}

export interface AuthnStepUpInput {
  readonly session: SessionHandle;
  readonly step: string;
  readonly response: string;
  readonly ctx: AuthnContext;
}

export interface AuthnImpersonationStartInput {
  readonly session: SessionHandle;
  readonly target: IdentityRef;
  readonly ctx: AuthnContext;
}

export interface AuthnImpersonationStopInput {
  readonly session: SessionHandle;
  readonly ctx: AuthnContext;
}

export interface AuthnLinkInput {
  readonly session: SessionHandle;
  readonly external: ExternalSubject;
  readonly ctx: AuthnContext;
}

export interface AuthnUnlinkInput {
  readonly session: SessionHandle;
  readonly linkId: string;
  readonly ctx: AuthnContext;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.login': { input: AuthnLoginInput; output: AuthenticationResult };
    'authn.login.identified': { input: AuthnLoginIdentifiedInput; output: AuthenticationResult };
    'authn.mfa.verify': { input: AuthnMfaVerifyInput; output: AuthenticationResult };
    'authn.reauth': { input: AuthnReauthInput; output: boolean };
    'authn.session.stepUp': { input: AuthnStepUpInput; output: AuthenticationResult };
    'authn.impersonation.start': { input: AuthnImpersonationStartInput; output: ImpersonationStart };
    'authn.impersonation.stop': { input: AuthnImpersonationStopInput; output: SessionHandle | null };
    'authn.link': { input: AuthnLinkInput; output: LinkResult };
    'authn.unlink': { input: AuthnUnlinkInput; output: { ok: boolean } };
  }
}

/** What a refused or failed action hook audits: `hook:<code>` for a refusal, `hook_error` (with the hook class and why) for a hook that failed. */
export interface HookRefusal {
  readonly reason: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The audit reason of an error `Hooks.run(action, ...)` threw for its own hooks, or null for any other error, which the caller handles as before. */
export function hookRefusalOf(_err: unknown, _action: ActionName): HookRefusal | null {
  throw new Error('not implemented: hookRefusalOf');
}
