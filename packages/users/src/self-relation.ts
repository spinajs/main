import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';

import { UserBase } from './models/User.js';

/** The Uuid and Id of a user row: a `UserBase` instance, or any object with a string `Uuid`. */
function userRow(subject: unknown): { Uuid: string; Id?: unknown } | undefined {
  if (subject instanceof UserBase) {
    return subject;
  }

  if (subject !== null && typeof subject === 'object' && typeof (subject as { Uuid?: unknown }).Uuid === 'string') {
    return subject as { Uuid: string; Id?: unknown };
  }

  return undefined;
}

/**
 * `self`: the principal is the user the row (or, without a row, the ref) names; D4 makes that the Uuid.
 *
 * The engine evaluates a relation only against a subject, so the row decides. A ref keyed by the
 * numeric `Id` (an ORM ref of the `users` model) is fine as long as it names the same row; a ref that
 * names neither the row's Uuid nor its Id, a subject that is not a user row, and a type-level ref never
 * hold. `onBehalfOf` is not read: an agent acting for a user does not hold `self` on that user.
 */
abstract class SelfRelation extends RelationResolver {
  public readonly relation = 'self';

  public holds(principal: Principal, ref: ResourceRef, subject?: unknown): boolean {
    if (principal.type !== 'user' || typeof ref.id !== 'string') {
      return false;
    }

    if (subject === undefined || subject === null) {
      return ref.id === principal.id;
    }

    const row = userRow(subject);
    if (!row || (ref.id !== row.Uuid && ref.id !== String(row.Id))) {
      return false;
    }

    return row.Uuid === principal.id;
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
