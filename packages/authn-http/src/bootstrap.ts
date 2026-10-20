import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.http schema, so the configuration validates that subtree and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnHttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_HTTP_CONFIGURATION_SCHEMA);
  }
}
