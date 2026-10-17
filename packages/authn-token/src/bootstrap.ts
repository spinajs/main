import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_JWT_CONFIGURATION_SCHEMA, AUTHN_TOKEN_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.token and authn.jwt schemas, so the configuration validates those subtrees and fills their defaults. */
@Injectable(Bootstrapper)
export class AuthnTokenConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_TOKEN_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHN_JWT_CONFIGURATION_SCHEMA);
  }
}
