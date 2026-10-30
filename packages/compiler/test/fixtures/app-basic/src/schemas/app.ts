import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const APP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/app-basic/app.configuration.schema.json',
  $configurationModule: 'app',
  type: 'object',
  properties: { name: { type: 'string', default: 'app-basic' } },
};

registerConfigurationSchemaAtImport(APP_CONFIGURATION_SCHEMA);
