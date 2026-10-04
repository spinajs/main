import type { Principal } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';

/**
 * Which roles a token may use (`authz.token.rolePolicy`, design §8.2, §18.3(g), B24). It only
 * narrows: RBAC cuts every answer to the roles it was given, and those are never above the
 * owner's (B07).
 */
export abstract class TokenRolePolicy {
  /**
   * Of `roles`, the ones a token of `owner` may use; `profile` is the 2.x profile the token is pinned to.
   * `roles` may hold roles the owner does not have (a token without roles is asked about every role): filter them, never infer ownership from them.
   * Synchronous: RBAC asks it on every check of a token principal, so it must answer from its arguments and config, with no IO.
   */
  abstract allowedRoles(owner: Principal, roles: readonly string[], profile?: string): readonly string[];

  /** Profiles `owner` may pin a token to. Default: none (as in 2.x). */
  allowedProfiles(_owner: Principal): readonly string[] | Promise<readonly string[]> {
    return [];
  }
}

/** The default policy: every role the owner holds. */
@Injectable(TokenRolePolicy)
export class OwnRolesTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
    return [...roles];
  }
}
