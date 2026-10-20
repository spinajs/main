import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_TOTP_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.mfa.totp schema, so the configuration validates that subtree and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnTotpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_TOTP_CONFIGURATION_SCHEMA);
  }
}
