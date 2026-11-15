import { PERMISSION_PATTERN } from '@spinajs/authz';
import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const name = { type: 'string', minLength: 1 };
const permission = { type: 'string', pattern: PERMISSION_PATTERN.source };
const positive = { type: 'integer', minimum: 1 };

export const STUDIO_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/studio.configuration.schema.json',
  $configurationModule: 'studio',
  description: 'Spina Studio configuration (studio.*)',
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false },
    allowProduction: { type: 'boolean', default: false },
    path: { ...name, default: '/_studio' },
    ui: { type: 'object', default: {}, properties: { path: name } },
    buffers: {
      type: 'object',
      default: {},
      properties: {
        traces: { ...positive, default: 1000 },
        spansPerTrace: { ...positive, default: 2000 },
        logs: { ...positive, default: 5000 },
        slowQueries: { ...positive, default: 200 },
      },
    },
    captureBindings: { type: 'boolean', default: false },
    redactAttributes: { type: 'array', items: name },
    auth: {
      type: 'object',
      default: {},
      properties: {
        skipInDevelopment: { type: 'boolean', default: false },
        domain: { ...name, default: 'root' },
        policies: { type: 'object', additionalProperties: name },
        permissions: { type: 'object', additionalProperties: { anyOf: [permission, { type: 'array', minItems: 1, items: permission }] } },
      },
    },
  },
};

registerConfigurationSchemaAtImport(STUDIO_CONFIGURATION_SCHEMA);
