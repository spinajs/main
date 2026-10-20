import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.session schema, so the configuration validates that subtree and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnSessionConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_SESSION_CONFIGURATION_SCHEMA);
  }
}
