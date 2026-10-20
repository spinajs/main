import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';
import CONFIGURATION_SCHEMA from './schemas/validation.js';

@Injectable(Bootstrapper)
export class ValidatorBootstraper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(CONFIGURATION_SCHEMA);
  }
}
