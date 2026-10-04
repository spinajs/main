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
import { SYSTEM_LOGIN, User, USER_SECURITY_METADATA_KEYS } from './models/User.js';
import { runAsSystem } from './system.js';
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
export * from './permission-service.js';
export * from './util.js';
export * from './profile.js';
export * from './impersonation.js';
export * from './ownership.js';
export * from './model-token.js';
export * from './cli/RbacCliCommand.js';
export * from './principal/index.js';
export * from './self-relation.js';
export * from './user-resource-adapter.js';
export * from './default-roles-check.js';

// fix error `The requested module 'accesscontrol' is a CommonJS module`
const { Permission } = ac;
export { AccessControl, Permission };

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    /**
     * Credential-bearing metadata never leaves the server in a dehydrated user.
     * Seeded here rather than as the field initialiser so an application ( or
     * another package, eg. authn-totp adding its 2FA keys ) can append to
     * the list without having to restate this one. De-duplicated because tests
     * run bootstrappers repeatedly against a live static.
     */
    UserMetadataBase._hiddenKeys = [...new Set([...UserMetadataBase._hiddenKeys, ...USER_SECURITY_METADATA_KEYS])];

    // Default user model class. Guarded so an application's override survives any
    // registration order — the app always uses asValue(RBAC_USER_MODEL, true).
    if (!DI.RootContainer.Cache.has(RBAC_USER_MODEL)) {
      DI.register(User).asValue(RBAC_USER_MODEL);
    }

    /** @deprecated 3.0: roles and grants live in `authz.rbac`; users no longer reads it. R1 deletes it. */
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
     * The user of a legacy session, read by Uuid.
     *
     * @deprecated 3.0: `UserPrincipalFactory.principalOf`. R1 deletes it.
     */
    DI.register((_: IContainer, userUUID: string) => {
      return runAsSystem('session-restore', () =>
        userModel()
          .where({
            Uuid: userUUID,
          })
          .populate('Metadata')
          .isActiveUser()
          .firstOrFail(),
      );
    }).as('RbacUserFactory');

    /**
     * A never-stored guest, active while `authz.principals.anonymous.enabled`.
     *
     * @deprecated 3.0: the anonymous principal with `authz.rbac.anonymousRoles`. R1 deletes it.
     */
    DI.register((_) => {
      const conf = DI.get(Configuration);

      return new (userModel())({
        Login: 'guest',
        Email: 'guest@spinajs.com',
        IsActive: conf!.get('authz.principals.anonymous.enabled', false),
      });
    }).as('RbacGuestUserFactory');

    /**
     * The {@link SYSTEM_LOGIN} account, as the registered user model: machine-token policies put it in
     * `storage.User`, where the application's hooks expect their own model.
     *
     * @deprecated 3.0: the `SYSTEM` principal of `@spinajs/authz`. R1 deletes it.
     */
    DI.register(async (_) => {
      const store = DI.get(AsyncLocalStorage) as AsyncLocalStorage<IRbacAsyncStorage> | undefined;
      const lookup = () => userModel().select().where('Login', SYSTEM_LOGIN).firstOrFail();

      // The 2.x ORM middleware does not know runAs and would scope the lookup by the caller in the
      // surrounding store; the skip goes into a nested store so the caller's own context is kept.
      const unscoped = store ? () => store.run({ ...(store.getStore() ?? {}), SkipModelPermissionCheck: true }, lookup) : lookup;

      return await runAsSystem('system-user', unscoped);
    }).as('RbacSystemUserFactory');
  }
}
