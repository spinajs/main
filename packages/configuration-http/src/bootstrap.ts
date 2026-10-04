import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerAccessResource } from '@spinajs/authz-orm';
import { DbConfig, requireSystemPrincipal } from '@spinajs/configuration-db-source';

/**
 * `DbConfig` lives in `@spinajs/configuration-db-source`, which does not depend on authz. Its
 * `@Model('configuration')` only names the table; this registers it as the `configuration` access
 * resource so the ORM guard scopes every query on it.
 */
@Injectable(Bootstrapper)
export class ConfigurationHttpBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerAccessResource(DbConfig, 'configuration');
    requireSystemPrincipal();
  }
}
