import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { UPLOAD_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the upload schema, as authn-token/src/bootstrap.ts:7-13 does for its modules. */
@Injectable(Bootstrapper)
export class UploadConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(UPLOAD_CONFIGURATION_SCHEMA);
  }
}
