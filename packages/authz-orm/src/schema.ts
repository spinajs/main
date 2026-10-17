import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { ACCESS_FIELD } from './lists/access-field.js';

export const ORM_DOMAIN_DEFAULT = 'root';

export const AUTHZ_ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-orm.configuration.schema.json',
  $configurationModule: 'authz.orm',
  description: 'ORM authorization configuration (authz.orm.*)',
  type: 'object',
  properties: {
    // The authz domain whose service plans lists and whose stores a delete cleans up.
    domain: { type: 'string', minLength: 1, default: ORM_DOMAIN_DEFAULT },
    // The model property that carries `.withAccess()` answers (design §10.3).
    accessField: { type: 'string', minLength: 1, default: ACCESS_FIELD },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_ORM_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzOrmConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ORM_CONFIGURATION_SCHEMA);
  }
}
