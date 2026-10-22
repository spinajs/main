import type { Principal } from './principal.js';

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

/** The credential admin routes of authn-http (A25); the `action` of `authn.admin.credentials` (CredentialAdminRule, `@spinajs/authn/hooks`). */
export type CredentialAdminAction = 'password-reset' | 'mfa-reset' | 'sessions' | 'tokens';
