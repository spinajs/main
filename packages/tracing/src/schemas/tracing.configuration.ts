import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

import { DEFAULT_TRACING_OPTIONS } from '../options.js';

export const TRACING_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/tracing.configuration.schema.json',
  $configurationModule: 'tracing',
  description: 'Tracing configuration (tracing.*)',
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: DEFAULT_TRACING_OPTIONS.enabled },
    serviceName: { type: 'string', minLength: 1 },
    resourceAttributes: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
    sampler: {
      type: 'object',
      default: structuredClone(DEFAULT_TRACING_OPTIONS.sampler),
      properties: {
        type: { enum: ['always', 'never', 'ratio', 'parent-ratio'] },
        ratio: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
};

registerConfigurationSchemaAtImport(TRACING_CONFIGURATION_SCHEMA);
