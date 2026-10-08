import type { ExternalSubject, IdentityRef } from './credentials.js';
import type { Principal } from './principal.js';

/** req.storage keys written by AuthnMiddleware (D26). */
export interface IAuthnPrincipalStorage {
  /** null: no or pending credentials. authz-http's AuthnPrincipalSource reads it. */
  AuthnPrincipal?: Principal | null;
}

/** Registered with Array.ofType; users' AccessResponseExtension adds `Access` (D26). */
export abstract class AuthnResponseExtension {
  /** Adds fields to body, the answer being built. */
  abstract extend(kind: 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami', principal: Principal, body: Record<string, unknown>): Promise<void>;
}

/** users: RbacRoleSource over the RBAC summary; none registered ⇒ role switch off. */
export abstract class RoleSource {
  abstract rolesOf(principal: Principal): Promise<readonly { role: string; requirePassword: boolean }[]>;
}

/**
 * Registered with Array.ofType; runs after a successful external login (OIDC), e.g. an app's group sync through AuthzAdmin.
 * AuthnService calls every hook for an interactive strategy's external outcome, after the identity is resolved and its status
 * checked and before MFA and the session are issued; a throw fails the login with the A02 answer and issues no session (audit
 * reason hook_error). Earlier hooks are not rolled back, so hooks must be idempotent.
 */
export abstract class ExternalLoginHook {
  abstract afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void>;
}

/** The credential admin routes of authn-http (A25). */
export type CredentialAdminAction = 'password-reset' | 'mfa-reset' | 'sessions' | 'tokens';

/**
 * users: AuthzCredentialAdminGuard (D26 pattern). None registered ⇒ the credential admin routes are off (404).
 * forbidden: the actor lacks users:credentials at GLOBAL, or is impersonating, or did not sign in interactively;
 * protected_role: the target holds a protected role; escalation: the actor does not cover the target's rights (B26
 * strict subset, AuthzService.covers); not_found: no such target. The routes call it before any effect (A25: a refused
 * call changes nothing).
 */
export abstract class CredentialAdminGuard {
  abstract allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction): Promise<{ ok: true } | { ok: false; code: 'forbidden' | 'protected_role' | 'escalation' | 'not_found' }>;
}
