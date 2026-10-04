import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';

/**
 * `self`: the principal is the user the ref names (`user:<Uuid>`, D4). A type-level ref never holds, and
 * a delegated principal holds only as itself: `onBehalfOf` is not read, so an agent acting for a user
 * does not hold `self` on that user.
 */
abstract class SelfRelation extends RelationResolver {
  public readonly relation = 'self';

  public holds(principal: Principal, ref: ResourceRef): boolean {
    return principal.type === 'user' && typeof ref.id === 'string' && ref.id === principal.id;
  }
}

/** `self` on the `user` resource (the signed-in user's own record). */
@Injectable(RelationResolver)
export class UserSelfRelation extends SelfRelation {
  public readonly type = 'user';
}

/** `self` on the `users` resource (the admin collection), for grants such as `users:update` on one's own row. */
@Injectable(RelationResolver)
export class UsersSelfRelation extends SelfRelation {
  public readonly type = 'users';
}
