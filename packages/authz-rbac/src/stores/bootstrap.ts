import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';
import { AUTHZ_RBAC_CONFIGURATION_SCHEMA } from './schema.js';

@Injectable(Bootstrapper)
export class RbacConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_RBAC_CONFIGURATION_SCHEMA);
  }
}
