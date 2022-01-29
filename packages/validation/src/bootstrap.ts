import { Bootstrapper, DI } from '@spinajs/di';
import CONFIGURATION_SCHEMA from './schemas/validation';

export class ValidatorBootstraper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}
