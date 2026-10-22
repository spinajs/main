// The augmentation below resolves '@spinajs/hooks' only when this file imports it.
import '@spinajs/hooks';
import type { AuthnContext, CodeRequestResult, IdentityRef, Principal, Session } from '@spinajs/authn/contracts';

// `authn.admin.credentials` is authn's (`@spinajs/authn/hooks`): users-http's admin routes run it too.
export type { CredentialAdminInput } from '@spinajs/authn/hooks';

/** Runs before the account is looked up, so a hook cannot tell a known login from an unknown one. */
export interface CodeRequestInput {
  readonly login: string;
  readonly ctx: AuthnContext;
}

/**
 * `login` and `email` are mutable: the route checks the password policy again on changed values and the IdentityRegistrar
 * validates them. Runs before the registrar looks the account up; a hook must not branch on whether it exists.
 */
export interface RegistrationInput {
  login: string;
  email: string;
  readonly ctx: AuthnContext;
}

export type RegistrationOutput = { readonly status: 'created'; readonly id: IdentityRef } | { readonly status: 'exists'; readonly id: IdentityRef };

export interface LogoutInput {
  readonly session: Session;
  readonly ctx: AuthnContext;
}

/** `handle` is the session's one-way handle, or `'others'` for every session but the current one. */
export interface SessionsRevokeInput {
  readonly subject: IdentityRef;
  readonly handle: string;
  readonly ctx: AuthnContext;
}

export interface RoleSwitchInput {
  readonly session: Session;
  readonly role: string;
  readonly ctx: AuthnContext;
}

/** Opt-in (`authn.http.hooks.request`): runs on every request once the principal is resolved. */
export interface RequestInput {
  readonly principal: Principal | null;
  readonly method: string;
  readonly path: string;
  readonly ip?: string;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'authn.code.request': { input: CodeRequestInput; output: CodeRequestResult };
    'authn.registration': { input: RegistrationInput; output: RegistrationOutput };
    'authn.logout': { input: LogoutInput; output: void };
    /** The number of sessions ended. */
    'authn.sessions.revoke': { input: SessionsRevokeInput; output: number };
    'authn.role.switch': { input: RoleSwitchInput; output: Principal };
    'authn.request': { input: RequestInput; output: void };
  }
}
