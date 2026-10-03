import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { AUTHZ_RBAC_CONFIGURATION_SCHEMA } from './schema.js';

@Injectable(Bootstrapper)
export class RbacConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(AUTHZ_RBAC_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}
