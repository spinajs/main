import ac from 'accesscontrol';
import { AccessControl } from 'accesscontrol';

import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log } from '@spinajs/log';

import './auth.js';
import './password.js';
import './session.js';
import './session-expiration.js';
import './session-codec.js';
import './ownership.js';
import { User, USER_SECURITY_METADATA_KEYS } from './models/User.js';
import { UserMetadataBase } from './models/UserMetadata.js';

export * from './interfaces.js';
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
export * from './util.js';
export * from './profile.js';
export * from './impersonation.js';
export * from './ownership.js';

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
      return User.where({
        Uuid: userUUID,
      })
        .populate('Metadata')
        .isActiveUser()
        .firstOrFail();
    }).as('RbacUserFactory');

    DI.register((_) => {
      const conf = DI.get(Configuration);
      const guestEnabled = conf!.get('rbac.enableGuestAccount', false);

      return new User({
        Login: 'guest',
        Email: 'guest@spinajs.com',
        Role: ['guest'],
        IsActive: guestEnabled,
      });
    }).as('RbacGuestUserFactory');

    DI.register(async (_) => {
      const system = await User.select().where('Role', ['system']).where('Login', '__system__').firstOrFail();
      return system;
    }).as('RbacSystemUserFactory');

    DI.register(async (_, role: string) => {
      return new User({
        Login: `__user_from_role_${role}__`,
        Email: `__user_from_role_${role}__@system`,
        Role: [role],
        IsActive: true,
      });
    }).as('RbacUserFromRoleFactory');
  }
}
