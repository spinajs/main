import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import './auth';
import './password';
import './session';
import { AccessControl } from 'accesscontrol';
import { Configuration } from '@spinajs/configuration';

export * from './interfaces';
export * from './auth';
export * from './password';
export * from './session';
export * from './models/User';
export * from './models/UserMetadata';
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
