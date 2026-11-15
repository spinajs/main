import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const INTL_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/intl-http.configuration.schema.json',
  $configurationModule: 'intl.http',
  description: 'Request language over HTTP (intl.http.*)',
  type: 'object',
  properties: {
    vary: { type: 'boolean', default: true },
  },
};

registerConfigurationSchemaAtImport(INTL_HTTP_CONFIGURATION_SCHEMA);

// DI.clearCache() drops the registration made at import; a Bootstrapper makes it again.
@Injectable(Bootstrapper)
export class IntlHttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(INTL_HTTP_CONFIGURATION_SCHEMA);
  }
}
