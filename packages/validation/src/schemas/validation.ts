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
  },
};

export default CONFIGURATION_SCHEMA;
