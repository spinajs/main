import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const CONFIGURATION_SCHEMA = {
  $id: 'spinajs/validation.configuration.schema.json',
  $configurationModule: 'validation',
  description: 'Validation module configuration schema',
  type: 'object',
  properties: {
    allErrors: { type: 'boolean' },
    removeAdditional: { type: 'boolean' },
    useDefaults: { type: 'boolean' },
    coerceTypes: { type: 'boolean' },
    messages: { type: 'boolean' },
  },
};

registerConfigurationSchemaAtImport(CONFIGURATION_SCHEMA);

export default CONFIGURATION_SCHEMA;
