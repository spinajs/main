import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

// Mirrors @spinajs/hooks until it ships a manifest fragment.
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
