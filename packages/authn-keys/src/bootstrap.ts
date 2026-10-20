import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_KEYS_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.keys schema, so the configuration validates that subtree and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnKeysConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_KEYS_CONFIGURATION_SCHEMA);
  }
}
