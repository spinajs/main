import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';
import { AUTHZ_CONFIGURATION_SCHEMA } from './schema.js';

@Injectable(Bootstrapper)
export class AuthzConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_CONFIGURATION_SCHEMA);
  }
}
