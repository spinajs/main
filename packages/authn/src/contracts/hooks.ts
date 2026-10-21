import type { IdentityRef } from './credentials.js';
import type { Ceiling, Principal } from './principal.js';
import type { SessionHandle, SessionIssuer } from './session.js';

export type { IAuthnPrincipalStorage } from '@spinajs/principal';

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
 * Registered with Array.ofType; users: OrderedActiveRoleHook (`authz.principals.roleSwitch.initial`). authn-http asks the hooks
 * in registration order once its login routes (password, key challenge, email code, passkey) or MFA completion have
 * issued the active session, before the answer is built; a step-up or re-authentication asks none. The first ceiling
 * answered is stored as the session's ActiveRole, the key a role switch writes, and narrows the principal of the answer
 * and of every later request on the session; undefined passes to the next hook. The ceiling must name at most one role
 * and nothing else (`{ roles: [role] }`, or `{ roles: [] }` for none).
 * A throw, or any other ceiling, ends the session and fails the request: it never lives on with every held role.
 */
export abstract class SessionStartHook {
  abstract onStart(kind: 'login' | 'mfa', session: SessionHandle, principal: Principal, sessions: SessionIssuer): Promise<Ceiling | undefined>;
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
