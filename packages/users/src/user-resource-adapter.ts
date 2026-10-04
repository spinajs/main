import { AuthzService, GLOBAL, ResourceAdapter, SYSTEM } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';

import { UserBase } from './models/User.js';
import type { User } from './models/User.js';
import { userModel } from './model-token.js';

const USER = 'user';

/**
 * The `user` resource: one user, addressed by Uuid (D4). It maps user records to refs, tells the engine
 * whether a user exists (an unknown or soft-deleted one has no ancestors, so every check on it fails
 * closed), and loads the row for checks that need one (authz-http's `subject: 'load'`), so a `self` grant
 * is decided on the row.
 *
 * Only `user`: the `users` admin collection is left to the ORM adapter of the user model. The `self`
 * resolvers register on their own (`RelationResolver`), so `relations()` is not implemented: the host
 * refuses a second resolver for the same type and relation.
 */
@Injectable(ResourceAdapter)
export class UserResourceAdapter extends ResourceAdapter<User> {
  public readonly kind = 'users';
  public readonly types = [USER];

  public accepts(target: unknown): target is User {
    return target instanceof UserBase;
  }

  public refOf(user: User): ResourceRef {
    return { type: USER, id: user.Uuid };
  }

  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (ref.type !== USER) {
      return null;
    }

    if (ref.id === undefined) {
      return [ref, GLOBAL];
    }

    return (await this.find(ref.id, false)) ? [ref, GLOBAL] : null;
  }

  /** The user with metadata, or null when there is none (unknown or soft deleted). */
  public async load(ref: ResourceRef): Promise<User | null> {
    if (ref.type !== USER || ref.id === undefined) {
      return null;
    }

    return this.find(ref.id, true);
  }

  // As SYSTEM: the application's user model may be scoped, and the lookup itself must not be.
  protected async find(uuid: string, withMetadata: boolean): Promise<User | null> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const found = await authz.runAs(SYSTEM, 'user-resource-adapter', () => {
      const query = userModel().query().where('Uuid', uuid);
      return (withMetadata ? query.populate('Metadata') : query).first();
    });

    return (found as User | undefined) ?? null;
  }
}
