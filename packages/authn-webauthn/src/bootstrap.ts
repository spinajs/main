import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHN_WEBAUTHN_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.webauthn schema, so the configuration validates that subtree and fills its defaults. */
@Injectable(Bootstrapper)
export class AuthnWebAuthnConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHN_WEBAUTHN_CONFIGURATION_SCHEMA);
  }
}
