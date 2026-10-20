import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_LOCAL_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.local schema, so the configuration validates that subtree and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnLocalConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_LOCAL_CONFIGURATION_SCHEMA);
  }
}
