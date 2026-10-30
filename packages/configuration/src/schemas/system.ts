import { registerConfigurationSchemaAtImport } from '../schemas.js';

export const SYSTEM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/system.configuration.schema.json',
  $configurationModule: 'system',
  description: 'Framework-level settings (system.*)',
  type: 'object',
  additionalProperties: true,
  properties: {
    dirs: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
      default: {},
    },
    manifest: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, default: 'app.manifest.json', description: 'app.manifest.json written by `spinajs build`; relative to the working directory.' },
        mode: {
          type: 'string',
          enum: ['off', 'prefer', 'require'],
          default: 'off',
          description: 'off: directory scans only. prefer: manifest entries first, scans for what the manifest lacks. require: manifest only; a missing manifest or section fails the boot.',
        },
      },
    },
  },
};

// Registered at import: `system.*` is read by every package before any Bootstrapper runs.
registerConfigurationSchemaAtImport(SYSTEM_CONFIGURATION_SCHEMA);
