import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Config, Configuration, registerConfigurationSchema } from '@spinajs/configuration';

import type { ConfiguredOidc } from './options/options.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA } from './options/schema.js';
import { providerNamesOf, registerOidcStrategies } from './providers.js';

/**
 * Registers the authn.oidc schema, so the Configuration validates the providers, then the 'oidc:<name>' strategy services
 * before the core's registry looks them up (D4).
 */
@Injectable(Bootstrapper)
export class OidcBootstrapper extends Bootstrapper {
  @Config('authn.oidc')
  protected Oidc: ConfiguredOidc | undefined;

  public async bootstrap(): Promise<void> {
    registerConfigurationSchema(AUTHN_OIDC_CONFIGURATION_SCHEMA);
    // A @Config read needs the Configuration resolved; resolving it also validates the schema just registered.
    await DI.resolve(Configuration);
    registerOidcStrategies(providerNamesOf(this.Oidc));
  }
}
