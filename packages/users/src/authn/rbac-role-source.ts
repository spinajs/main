import { AuthzConfigError } from '@spinajs/authz';
import { RoleSource } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';
import { RbacService } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

import { DEFAULT_ACCESS_DOMAIN } from './access-schema.js';
import { ACCESS_DOMAIN_KEY, accessDomain, heldRoles, registeredInDomain, signedInInteractively } from './target-guard.js';

/** Roles a role switch may only activate after a fresh password (A26). */
export const ROLE_SWITCH_PASSWORD_KEY = 'authz.principals.roleSwitch.requirePassword';

type RoleOffer = Awaited<ReturnType<RoleSource['rolesOf']>>[number];

/**
 * authn's RoleSource (A26, B24): the roles a user holds at any scope in the access domain (`authz.http.access.domain`),
 * by name, sorted, each flagged with `requirePassword`: listed in `authz.principals.roleSwitch.requirePassword`; with
 * the key unset or null every role asks for the password (N8a-D9). Read from the stored assignments, not the summary
 * the plan names: the summary applies the role switch ceiling and would hide the roles to switch back to.
 * Scoped holdings count: the list also feeds MFA `forceForRoles` and authn-token's owner check, where a role held at a
 * scope is held; offering it to a role switch is harmless, as `ceiling.roles` only narrows.
 * Empty for a sign-in that is not interactive (`authn` not an object, or a method other than password, oidc, ldap,
 * saml), an agent or delegate, and any principal that is not a user. A principal without authn facts (authn-token's
 * owner check) gets all its roles. An impersonation session gets the target's roles, which are the session's.
 * @throws AuthzConfigError when the access domain has no RbacService of its own, or the 3.0 key is malformed
 */
@Injectable(RoleSource)
export class RbacRoleSource extends RoleSource {
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;

  @Config(ROLE_SWITCH_PASSWORD_KEY)
  protected RequirePassword: readonly string[] | null | undefined;

  public async rolesOf(principal: Principal): Promise<readonly RoleOffer[]> {
    if (principal.type !== 'user' || principal.onBehalfOf || (principal.authn != null && !signedInInteractively(principal.authn))) {
      return [];
    }

    const domain = await accessDomain(this.AccessDomain);
    const rbac = await registeredInDomain(domain, RbacService);
    const requiresPassword = this.passwordRule();
    const names = [...new Set(await heldRoles(rbac, domain.name, principal))].sort();
    return names.map((role) => ({ role, requirePassword: requiresPassword(role) }));
  }

  private passwordRule(): (role: string) => boolean {
    const listed: unknown = this.RequirePassword;
    // The schema is the gate; this floor is for values set at runtime that never went through it (a bare string would spread into characters and fail open).
    if (listed !== undefined && listed !== null && (!Array.isArray(listed) || !listed.every((r) => typeof r === 'string'))) {
      throw new AuthzConfigError(`${ROLE_SWITCH_PASSWORD_KEY} must be a list of role names, got ${JSON.stringify(listed)}`);
    }
    // Fail safe: no list configured means every switch re-verifies the password.
    if (listed === undefined || listed === null) return () => true;
    const set = new Set<string>(listed as string[]);
    return (role) => set.has(role);
  }
}
