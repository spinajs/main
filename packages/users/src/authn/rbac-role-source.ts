import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import { RoleSource } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';
import { RbacService } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';

import { NON_INTERACTIVE_METHODS, accessDomain, registeredInDomain } from './target-guard.js';

/** Roles a role switch may only activate after a fresh password (A26). */
export const ROLE_SWITCH_PASSWORD_KEY = 'authz.principals.roleSwitch.requirePassword';

type RoleOffer = Awaited<ReturnType<RoleSource['rolesOf']>>[number];

/**
 * authn's RoleSource (A26, B24): the roles a user holds at GLOBAL in the access domain (`authz.http.access.domain`),
 * by name, sorted, each flagged with `requirePassword`. The source is `RbacService.rolesOf` with `ceiling: false`, not
 * the summary the plan names: the summary applies the role switch ceiling and would hide the roles to switch back to.
 * Scoped holdings are left out: `ceiling.roles` and token roles are names applied at every scope, so only an account-wide
 * holding answers "holds this role" for them (the 2.x switch offered `users.Role`, now GLOBAL rows). Empty for a sign-in without a person at a session (token, jws, http-signature),
 * an agent or delegate, and any principal that is not a user. A principal without authn facts (authn-token's owner
 * check) gets all its roles. An impersonation session gets the target's roles, which are the session's.
 * @throws AuthzConfigError when the access domain has no RbacService of its own, or the config is malformed
 */
@Injectable(RoleSource)
export class RbacRoleSource extends RoleSource {
  public async rolesOf(principal: Principal): Promise<readonly RoleOffer[]> {
    if (principal.type !== 'user' || principal.onBehalfOf || (principal.authn && NON_INTERACTIVE_METHODS.has(principal.authn.method))) {
      return [];
    }

    const rbac = await registeredInDomain(await accessDomain(), RbacService);
    const withPassword = new Set(await passwordRoles());
    const held = await rbac.rolesOf(principal, GLOBAL, { ceiling: false });
    const names = [...new Set(held.map((h) => h.role))].sort();
    return names.map((role) => ({ role, requirePassword: withPassword.has(role) }));
  }
}

async function passwordRoles(): Promise<readonly string[]> {
  const value = ((await DI.resolve(Configuration)) as Configuration).get<unknown>(ROLE_SWITCH_PASSWORD_KEY, []);
  if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && r !== '')) {
    throw new AuthzConfigError(`${ROLE_SWITCH_PASSWORD_KEY} must be a list of role names, got ${JSON.stringify(value)}`);
  }
  return value as string[];
}
