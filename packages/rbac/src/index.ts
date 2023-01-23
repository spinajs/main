import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import './auth.js';
import './password.js';
import './session.js';
import { AccessControl } from 'accesscontrol';
import { Configuration } from '@spinajs/configuration';

export * from './interfaces.js';
export * from './auth.js';
export * from './password.js';
export * from './session.js';
export * from './models/User.js';
export * from './models/UserMetadata.js';
export * from './models/UserTimeline.js';
export * from './migrations/RBACInitial_2022_06_28_01_13_00.js';
export * from './events/index.js';
export { AccessControl } from 'accesscontrol';

@Injectable(Bootstrapper)
export class RbacBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    const ac = new AccessControl();
    DI.register(ac).asValue('AccessControl');
    DI.once('di.resolved.Configuration', (container: IContainer, configuration: Configuration) => {
      const ac = container.get<AccessControl>('AccessControl');
      const grants = configuration.get('rbac.grants');
      if (grants) {
        ac.setGrants(grants);
      }
    });
  }
}
