import ac from 'accesscontrol';
import { AccessControl } from 'accesscontrol';

import { AsyncLocalStorage } from 'async_hooks';

import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log } from '@spinajs/log';

import type { IRbacAsyncStorage } from './interfaces.js';

import './auth.js';
import './password.js';
import './session.js';
import './session-expiration.js';
import './session-codec.js';
import './ownership.js';
import { User, USER_SECURITY_METADATA_KEYS } from './models/User.js';
import { UserMetadataBase } from './models/UserMetadata.js';
import { RBAC_USER_MODEL, userModel } from './model-token.js';

export * from './interfaces.js';
export * from './exceptions.js';
export * from './auth.js';
export * from './password.js';
export * from './session.js';
export * from './session-expiration.js';
export * from './session-codec.js';
export * from './models/User.js';
export * from './models/UserMetadata.js';
export * from './migrations/RBACInitial_2022_06_28_01_13_00.js';
export * from './migrations/RBACRegisteredAt_2026_07_28_00_00_00.js';
export * from './events/index.js';
export * from './actions.js';
export * from './middleware.js';
export * from './decorators.js';
export * from './orm-permission.js';
export * from './util.js';
export * from './profile.js';
export * from './impersonation.js';
export * from './ownership.js';
export * from './model-token.js';

// fix error `The requested module 'accesscontrol' is a CommonJS module`
const { Permission } = ac;
export { AccessControl, Permission };

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    /**
     * Credential-bearing metadata never leaves the server in a dehydrated user.
     * Seeded here rather than as the field initialiser so an application ( or
     * another package, eg. rbac-http-user adding its 2FA keys ) can append to
     * the list without having to restate this one. De-duplicated because tests
     * run bootstrappers repeatedly against a live static.
     */
    UserMetadataBase._hiddenKeys = [...new Set([...UserMetadataBase._hiddenKeys, ...USER_SECURITY_METADATA_KEYS])];

    // Default user model class. Guarded so an application's override survives any
    // registration order — the app always uses asValue(RBAC_USER_MODEL, true).
    if (!DI.RootContainer.Cache.has(RBAC_USER_MODEL)) {
      DI.register(User).asValue(RBAC_USER_MODEL);
    }

    const ac = new AccessControl();
    DI.register(ac).asValue('AccessControl');
    DI.once('di.resolved.Configuration', (container: IContainer, configuration: Configuration) => {
      const ac = container.get<AccessControl>('AccessControl');
      const grants = configuration.get('rbac.grants');

      if (!grants) {
        const log = container.resolve(Log, ['rbac']);
        log.warn(`No grants are set in configuration for access control. Please check grants & permission configuration.`);
      } else {
        ac!.setGrants(grants);
      }
    });

    /**
     * Register factory function for creating user from session data
     */
    DI.register((_: IContainer, userUUID: string) => {
      return userModel()
        .where({
          Uuid: userUUID,
        })
        .populate('Metadata')
        .isActiveUser()
        .firstOrFail();
    }).as('RbacUserFactory');

    DI.register((_) => {
      const conf = DI.get(Configuration);
      const guestEnabled = conf!.get('rbac.enableGuestAccount', false);

      return new (userModel())({
        Login: 'guest',
        Email: 'guest@spinajs.com',
        Role: ['guest'],
        IsActive: guestEnabled,
      });
    }).as('RbacGuestUserFactory');

    DI.register(async (_) => {
      /**
       * The system account must resolve on EVERY code path — `_user_or_system` runs inside
       * scoped request contexts — so the lookup must never be row-scoped by an application's
       * `RbacUserModel` override. It used to buy that by querying the BASE `User` class, at
       * the cost of returning an instance of a class the application does not use: this
       * factory's result is written straight into `storage.User` by machine-token policies,
       * so an application model's own members ( a pool/segment accessor, say ) were missing
       * on exactly those requests, while present on every other one.
       *
       * `SkipModelPermissionCheck` states the intent directly instead — the rbac query
       * middleware reads it and applies no hook — so the query stays unscoped AND the
       * caller gets the model the rest of the system hands it. The rest of the store is
       * preserved: this runs inside a live request context and must not drop its user,
       * active role or token info.
       */
      const store = DI.get(AsyncLocalStorage) as AsyncLocalStorage<IRbacAsyncStorage> | undefined;
      const lookup = () => userModel().select().where('Role', ['system']).where('Login', '__system__').firstOrFail();

      if (!store) {
        return await lookup();
      }

      return await store.run({ ...(store.getStore() ?? {}), SkipModelPermissionCheck: true }, lookup);
    }).as('RbacSystemUserFactory');

    DI.register(async (_, role: string) => {
      return new (userModel())({
        Login: `__user_from_role_${role}__`,
        Email: `__user_from_role_${role}__@system`,
        Role: [role],
        IsActive: true,
      });
    }).as('RbacUserFromRoleFactory');
  }
}
