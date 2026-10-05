import { AuthzConfigError } from '@spinajs/authz';
import { RoleSource } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';
import { RbacService } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';

import { accessDomain, heldRoles, registeredInDomain, signedInInteractively } from './target-guard.js';

/** Roles a role switch may only activate after a fresh password (A26). */
export const ROLE_SWITCH_PASSWORD_KEY = 'authz.principals.roleSwitch.requirePassword';

// R1 deletes it with the other 2.x keys.
const LEGACY_ROLE_SWITCH_PASSWORD_KEY = 'rbac.roleSwitch.requirePassword';

type RoleOffer = Awaited<ReturnType<RoleSource['rolesOf']>>[number];

/**
 * authn's RoleSource (A26, B24): the roles a user holds at any scope in the access domain (`authz.http.access.domain`),
 * by name, sorted, each flagged with `requirePassword`: listed in `authz.principals.roleSwitch.requirePassword`, or
 * in the 2.x `rbac.roleSwitch.requirePassword` while the 3.0 key is unset (null counts as unset); with neither set every
 * role asks for the password (N8a-D9). Read from the stored assignments, not the summary the plan
 * names: the summary applies the role switch ceiling and would hide the roles to switch back to.
 * Scoped holdings count: the list also feeds MFA `forceForRoles` and authn-token's owner check, where a role held at a
 * scope is held; offering it to a role switch is harmless, as `ceiling.roles` only narrows.
 * Empty for a sign-in that is not interactive (`authn` not an object, or a method other than password, oidc, ldap,
 * saml), an agent or delegate, and any principal that is not a user. A principal without authn facts (authn-token's
 * owner check) gets all its roles. An impersonation session gets the target's roles, which are the session's.
 * @throws AuthzConfigError when the access domain has no RbacService of its own, or the config is malformed
 */
@Injectable(RoleSource)
export class RbacRoleSource extends RoleSource {
  public async rolesOf(principal: Principal): Promise<readonly RoleOffer[]> {
    if (principal.type !== 'user' || principal.onBehalfOf || (principal.authn != null && !signedInInteractively(principal.authn))) {
      return [];
    }

    const domain = await accessDomain();
    const rbac = await registeredInDomain(domain, RbacService);
    const requiresPassword = await passwordRule();
    const names = [...new Set(await heldRoles(rbac, domain.name, principal))].sort();
    return names.map((role) => ({ role, requirePassword: requiresPassword(role) }));
  }
}

async function passwordRule(): Promise<(role: string) => boolean> {
  const config = (await DI.resolve(Configuration)) as Configuration;
  for (const key of [ROLE_SWITCH_PASSWORD_KEY, LEGACY_ROLE_SWITCH_PASSWORD_KEY]) {
    const value = config.get<unknown>(key);
    if (value === undefined || value === null) {
      continue;
    }
    if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && r !== '')) {
      throw new AuthzConfigError(`${key} must be a list of role names, got ${JSON.stringify(value)}`);
    }
    const listed = new Set<string>(value);
    return (role) => listed.has(role);
  }
  // Fail safe, as the 2.x switch: no list configured means every switch re-verifies the password.
  return () => true;
}
