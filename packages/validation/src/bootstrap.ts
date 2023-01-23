import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import CONFIGURATION_SCHEMA from './schemas/validation.js';

@Injectable(Bootstrapper)
export class ValidatorBootstraper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}
