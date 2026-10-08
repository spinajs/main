import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

// Ajv's option types: a boolean, or one of its named modes.
const ajvOption = (...modes: string[]) => ({ anyOf: [{ type: 'boolean' }, { enum: modes }] });

const CONFIGURATION_SCHEMA = {
  $id: 'spinajs/validation.configuration.schema.json',
  $configurationModule: 'validation',
  description: 'Validation module configuration schema',
  type: 'object',
  properties: {
    allErrors: { type: 'boolean' },
    removeAdditional: ajvOption('all', 'failing'),
    useDefaults: ajvOption('empty'),
    coerceTypes: ajvOption('array'),
    messages: { type: 'boolean' },
  },
};

registerConfigurationSchemaAtImport(CONFIGURATION_SCHEMA);

export default CONFIGURATION_SCHEMA;
