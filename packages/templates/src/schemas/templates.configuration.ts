import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';

// The root stays open: each renderer package keeps its own section here (templates.pug, templates.pdf, ...).
export const TEMPLATES_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/templates.configuration.schema.json',
  $configurationModule: 'templates',
  description: 'Templates configuration (templates.*)',
  type: 'object',
  properties: {
    cache: {
      type: 'object',
      properties: {
        // No default: unset falls back to 'always' in development and 'cache' in production.
        mode: { enum: ['cache', 'revalidate', 'always'] },
      },
    },
  },
};

registerConfigurationSchemaAtImport(TEMPLATES_CONFIGURATION_SCHEMA);

// DI.clearCache() drops the registration made at import; a Bootstrapper makes it again.
@Injectable(Bootstrapper)
export class TemplatesConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(TEMPLATES_CONFIGURATION_SCHEMA);
  }
}
