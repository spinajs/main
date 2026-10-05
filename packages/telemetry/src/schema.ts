import { PERMISSION_PATTERN } from '@spinajs/authz';

const name = { type: 'string', minLength: 1 };
const permission = { type: 'string', pattern: PERMISSION_PATTERN.source };

// Only the auth block is validated here; the other telemetry keys are @Config properties with code defaults.
export const TELEMETRY_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/telemetry.configuration.schema.json',
  $configurationModule: 'telemetry',
  description: 'Telemetry configuration (telemetry.auth.*)',
  type: 'object',
  properties: {
    auth: {
      type: 'object',
      default: {},
      properties: {
        token: { type: 'string' },
        skipInDevelopment: { type: 'boolean', default: false },
        domain: { ...name, default: 'root' },
        policies: { type: 'object', additionalProperties: name },
        permissions: { type: 'object', additionalProperties: { anyOf: [permission, { type: 'array', minItems: 1, items: permission }] } },
      },
    },
  },
};
