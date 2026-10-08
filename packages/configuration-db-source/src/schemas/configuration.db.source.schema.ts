import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const CONFIGURATION_SCHEMA = {
  $id: 'spinajs/configuration.db.source.schema.json',
  $configurationModule: 'configuration_db_source',
  description: 'Configuration for cfg db source',
  type: 'object',
  properties: {
    connection: { type: 'string', default: 'default' },
    table: { type: 'string', default: 'configuration' },
  },
};

registerConfigurationSchemaAtImport(CONFIGURATION_SCHEMA);

export default CONFIGURATION_SCHEMA;
