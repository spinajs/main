import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { providerNamesOf, registerOidcStrategies } from './providers.js';

/** Registers the 'oidc:<name>' strategy services before the core's registry looks them up (D4). */
@Injectable(Bootstrapper)
export class OidcBootstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    const config = await DI.resolve(Configuration);
    registerOidcStrategies(providerNamesOf(config.get('authn.oidc')));
  }
}
