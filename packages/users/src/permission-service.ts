import { AccessControl, Permission } from 'accesscontrol';
import { DI } from '@spinajs/di';
import type { User } from './models/User.js';

/**
 * THE guarded accesscontrol probe — single home for the AccessControlError semantics
 * previously copy-pasted into the ORM query middleware and authn-http's RbacPolicy.
 * Answers the Permission object (grant attributes stay reachable), or null for a role
 * unknown to accesscontrol — which throws AccessControlError for any role absent from
 * the grants map and rejects the whole role array on one unknown member. A genuine
 * programming error (bad permission name) still propagates loud.
 *
 * @deprecated 3.0: await authz().can(authz().current(), '<resource>:<action>'). R1 deletes it.
 */
export function probeGrant(roles: string | string[], permission: string, resource: string): Permission | null {
  const ac = DI.get<AccessControl>('AccessControl');
  if (!ac) {
    throw new Error('no AccessControl registered in DI — rbac is not bootstrapped');
  }

  try {
    return (ac.can(roles) as unknown as Record<string, (r: string) => Permission>)[permission](resource);
  } catch (err) {
    if (AccessControl.isAccessControlError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * THE ActiveRole rule — single home for the narrowing previously inlined in the ORM
 * query middleware and authn-http's checkRoutePermission. The session's ActiveRole
 * applies only to the user it was selected for — matched by id; any other user answers
 * their full role list.
 *
 * The storage parameter is structural (not IRbacAsyncStorage) so both the rbac ALS
 * store and http's request storage (whose User is `User | null`) fit.
 *
 * @deprecated 3.0: principal.ceiling?.roles; RbacService.rolesOf(principal, at). R1 deletes it.
 */
export function effectiveRoles(user: User, storage?: { User?: User | null; ActiveRole?: string }): string[] {
  if (storage?.ActiveRole && storage.User?.Id === user.Id) {
    return [storage.ActiveRole];
  }
  return user.Role;
}
