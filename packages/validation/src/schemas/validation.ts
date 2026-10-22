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
    strict: {
      anyOf: [
        {
          type: 'object',
          required: ['idPrefixes'],
          properties: {
            idPrefixes: { type: 'array', items: { type: 'string', minLength: 1 } },
            ajvStrict: ajvOption('log'),
          },
        },
        { enum: ['log'] },
        { type: 'boolean' },
      ],
      description: "An object: schemas whose $id starts with one of idPrefixes are validated with coerceTypes off. A boolean or 'log': Ajv's own strict mode.",
    },
  },
};

registerConfigurationSchemaAtImport(CONFIGURATION_SCHEMA);

export default CONFIGURATION_SCHEMA;
