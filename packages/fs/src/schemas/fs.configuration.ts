import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const nonEmpty = { type: 'string', minLength: 1 };

// The root and the provider entries stay open: providers take their own options (basePath, cleanup, ...) and other
// packages keep sections here (fs.onedrive).
export const FS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/fs.configuration.schema.json',
  $configurationModule: 'fs',
  description: 'File system configuration (fs.*)',
  type: 'object',
  properties: {
    defaultProvider: { ...nonEmpty, description: 'Provider the helper functions use when given none. fsService fails to boot without it.' },
    providers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'service'],
        properties: {
          name: nonEmpty,
          service: nonEmpty,
          provider: nonEmpty,
        },
      },
    },
    middlewareTimeoutMs: { type: 'number', exclusiveMinimum: 0 },
    hasher: {
      type: 'object',
      properties: {
        defaultAlgorithm: nonEmpty,
      },
    },
    fileInfo: {
      type: 'object',
      properties: {
        exifToolPath: nonEmpty,
        timeout: { type: 'integer', minimum: 1 },
        args: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

registerConfigurationSchemaAtImport(FS_CONFIGURATION_SCHEMA);

// DI.clearCache() drops the registration made at import; a Bootstrapper makes it again.
@Injectable(Bootstrapper)
export class FsConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(FS_CONFIGURATION_SCHEMA);
  }
}
