import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

export const AUTHZ_ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-orm.configuration.schema.json',
  $configurationModule: 'authz.orm',
  description: 'ORM authorization configuration (authz.orm.*)',
  type: 'object',
  properties: {
    // The authz domain whose service scopes the ORM queries.
    domain: { type: 'string', minLength: 1, default: 'root' },
    // true lets authz-orm use Postgres connections with jit on, whose rule lists take seconds.
    allowJit: { type: 'boolean', default: false },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_ORM_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzOrmConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ORM_CONFIGURATION_SCHEMA);
  }
}
