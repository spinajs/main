import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const INTL_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/intl.configuration.schema.json',
  $configurationModule: 'intl',
  description: 'Internationalization configuration (intl.*)',
  type: 'object',
  properties: {
    defaultLocale: { type: 'string', minLength: 1 },
    locales: { type: 'array', items: { type: 'string', minLength: 1 } },
    queryParameter: { type: 'string', minLength: 1 },
  },
};

registerConfigurationSchemaAtImport(INTL_CONFIGURATION_SCHEMA);

// DI.clearCache() drops the registration made at import; a Bootstrapper makes it again.
@Injectable(Bootstrapper)
export class IntlConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(INTL_CONFIGURATION_SCHEMA);
  }
}
