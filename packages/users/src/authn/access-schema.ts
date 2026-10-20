import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const DEFAULT_ACCESS_DOMAIN = 'root';

// authz-http owns authz.http; users reads the access domain without depending on it, so it validates the key itself.
export const USERS_ACCESS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/users-access.configuration.schema.json',
  $configurationModule: 'authz.http.access',
  description: 'The authz domain users judges access in (authz.http.access.*)',
  type: 'object',
  properties: {
    domain: { type: 'string', minLength: 1, default: DEFAULT_ACCESS_DOMAIN },
  },
};

registerConfigurationSchemaAtImport(USERS_ACCESS_CONFIGURATION_SCHEMA);
