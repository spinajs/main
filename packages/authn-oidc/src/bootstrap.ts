import { Autoinject, Bootstrapper, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
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

  @Autoinject(Container)
  protected Container!: IContainer;

  public async bootstrap(): Promise<void> {
    registerConfigurationSchema(AUTHN_OIDC_CONFIGURATION_SCHEMA, this.Container);
    // A @Config read needs the Configuration resolved. Not injected: that would boot it while the bootstrappers are being
    // resolved, before any of them registered its schema.
    await this.Container.resolve(Configuration);
    registerOidcStrategies(providerNamesOf(this.Oidc), this.Container);
  }
}
