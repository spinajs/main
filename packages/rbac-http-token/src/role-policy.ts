import { Injectable } from '@spinajs/di';
import { User } from '@spinajs/rbac';

import { AccessTokenRolePolicy } from './interfaces.js';

/**
 * The behaviour this package shipped before the policy seam: a token may carry
 * only roles its owner literally holds in `users.Role`.
 *
 * Safe by construction and needs no access-control lookup, which is why it
 * stays the default - an application that wants finer scopes opts in by
 * registering its own implementation under `rbac.token.rolePolicy.service`.
 */
@Injectable(AccessTokenRolePolicy)
export class OwnRolesTokenRolePolicy extends AccessTokenRolePolicy {
  public async allowedRoles(owner: User, _profile?: string): Promise<string[]> {
    return [...owner.Role];
  }
}

/**
 * Whether `role` matches any entry of `patterns`.
 *
 * A pattern is either an exact role name, or a name ending in `.*` which
 * matches that prefix and everything beneath it - `route.*` covers `route.home`
 * and `route.admin.users`, but not `routes.read`: the dot is part of the
 * boundary, so a pattern can never swallow an unrelated role that merely starts
 * with the same letters. No other wildcard syntax, on purpose - a full glob in
 * a security list invites patterns nobody can reason about.
 *
 * @param role - role name to test
 * @param patterns - exclusion patterns, typically from `rbac.token.excludedRoles`
 */
export function _role_excluded(role: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1); // keeps the trailing dot
      return role.startsWith(prefix);
    }

    return role === pattern;
  });
}
