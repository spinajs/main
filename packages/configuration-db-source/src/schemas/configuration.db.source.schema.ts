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

export default CONFIGURATION_SCHEMA;
