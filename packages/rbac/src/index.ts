import ac from 'accesscontrol';
import { AccessControl } from 'accesscontrol';

import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ModelData } from '@spinajs/orm';
import { Log } from '@spinajs/log';

import './auth.js';
import './password.js';
import './session.js';
import { User } from './models/User.js';

export * from './interfaces.js';
export * from './auth.js';
export * from './password.js';
export * from './session.js';
export * from './models/User.js';
export * from './models/UserMetadata.js';
export * from './models/UserTimeline.js';
export * from './migrations/RBACInitial_2022_06_28_01_13_00.js';
export * from './events/index.js';

// fix error `The requested module 'accesscontrol' is a CommonJS module`
const { Permission } = ac;
export { AccessControl, Permission };

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    const ac = new AccessControl();
    DI.register(ac).asValue('AccessControl');
    DI.once('di.resolved.Configuration', (container: IContainer, configuration: Configuration) => {
      const ac = container.get<AccessControl>('AccessControl');
      const grants = configuration.get('rbac.grants');

      if (!grants) {
        const log = container.resolve(Log, ['rbac']);
        log.warn(`No grants are set in configuration for access control. Please check grants & permission configuration.`);
      } else {
        ac.setGrants(grants);
      }
    });

    /**
     * Register factory function for creating user from session data
     */
    DI.register((_: IContainer, userData: ModelData<User>) => {
      return new User(userData);
    }).as('RbacUserFactory');

    DI.register((_) => {
      const conf = DI.get(Configuration);
      const guestEnabled = conf.get('rbac.enableGuestAccount', false);

      return new User({
        Login: 'guest',
        Email: 'guest@spinajs.com',
        Role: ['guest'],
        IsActive: guestEnabled,
      });
    }).as('RbacGuestUserFactory');
  }
}
