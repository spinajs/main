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
  },
};

registerConfigurationSchemaAtImport(AUTHZ_ORM_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzOrmConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ORM_CONFIGURATION_SCHEMA);
  }
}
