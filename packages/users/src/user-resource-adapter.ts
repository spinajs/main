import { AuthzService, GLOBAL, ResourceAdapter, SYSTEM } from '@spinajs/authz';
import type { PermissionDef, ResourceRef } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';

import type { User } from './models/User.js';
import { userModel } from './model-token.js';

const USER = 'user';
const USER_METADATA = 'user.metadata';
const USERS = 'users';

/**
 * The `user` resource: one user, addressed by Uuid (D4). It tells the engine whether a user exists (an
 * unknown or soft-deleted one has no ancestors, so every check on it fails closed) and loads the row for
 * checks that need one (authz-http's `subject: 'load'`), so a `self` grant is decided on the row.
 *
 * It accepts no object: the engine maps an object resource with the first adapter that accepts it,
 * whatever the permission, and user records belong to the `users` resource of the user model's ORM
 * adapter. A `user` check passes `{ type: 'user', id: Uuid }` ({@link refOf}) with the row as subject.
 *
 * The `self` resolvers register on their own (`RelationResolver`), so `relations()` is not implemented:
 * the host refuses a second resolver for the same type and relation.
 */
@Injectable(ResourceAdapter)
export class UserResourceAdapter extends ResourceAdapter<User> {
  public readonly kind = 'users';
  public readonly types = [USER];

  public accepts(_target: unknown): _target is User {
    return false;
  }

  /**
   * The `user` and `user.metadata` permissions users' shipped roles name: a role's literal permission must be registered,
   * and a glob matching none makes the role ungrantable (RFC C1-1). They come with the adapter, not with users' config
   * fragment, so they register only where `UserMetadataOwnerRelation`, which the `user` role's grant needs, does too.
   * No adapter serves `user.metadata`: its checks are type-level with the row as subject.
   * `users:credentials` is the default `authz.credentials.permission` that users' AuthzCredentialAdminGuard checks at
   * GLOBAL; it registers wherever that guard does, with the types users-http's config gives its `users:*` entries, so the
   * registry's merge of a second registration of the name changes nothing.
   */
  public permissions(): readonly Omit<PermissionDef, 'source'>[] {
    return [
      { name: 'user:read', resource: USER, action: 'read', types: [USER], fields: true },
      { name: 'user:update', resource: USER, action: 'update', types: [USER], fields: true },
      { name: 'user:impersonate', resource: USER, action: 'impersonate', types: [USER] },
      ...['read', 'create', 'update', 'delete'].map((action) => ({ name: `${USER_METADATA}:${action}`, resource: USER_METADATA, action, types: [USER_METADATA] })),
      { name: 'users:credentials', resource: USERS, action: 'credentials', types: [USERS] },
    ];
  }

  /** The `user` ref of a record, for callers that build the check themselves. */
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
