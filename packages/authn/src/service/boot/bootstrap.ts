import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_CONFIGURATION_SCHEMA } from '../../schemas/authn.configuration.js';

/** Registers the authn.* schema, so the configuration validates the merged tree and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_CONFIGURATION_SCHEMA);
  }
}
