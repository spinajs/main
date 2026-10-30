import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';

// A top-level switch, not under http. The key and certificate paths are http.ssl.key and http.ssl.cert.
export const HTTPS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/https.configuration.schema.json',
  $configurationModule: 'https',
  description: 'Serve over HTTPS (https)',
  // enum, not type: coerceTypes would turn null into false and silently serve plain HTTP.
  enum: [true, false],
};

registerConfigurationSchemaAtImport(HTTPS_CONFIGURATION_SCHEMA);

// DI.clearCache() drops the registration made at import; a Bootstrapper makes it again.
@Injectable(Bootstrapper)
export class HttpsConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(HTTPS_CONFIGURATION_SCHEMA);
  }
}
