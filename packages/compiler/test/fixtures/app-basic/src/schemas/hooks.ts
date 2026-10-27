import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

// Mirrors @spinajs/hooks: the package ships no manifest fragment yet, so the fixture registers the schema itself.
export const HOOKS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/hooks.configuration.schema.json',
  $configurationModule: 'hooks',
  type: 'object',
  properties: {
    timeoutMs: { type: 'integer', minimum: 1, maximum: 60000, default: 5000 },
    maxDepth: { type: 'integer', minimum: 1, maximum: 32, default: 8 },
  },
};

registerConfigurationSchemaAtImport(HOOKS_CONFIGURATION_SCHEMA);
