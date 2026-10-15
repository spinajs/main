import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { SCHEDULER_CONFIGURATION_SCHEMA } from './schemas/scheduler.configuration.js';

@Injectable(Bootstrapper)
export class SchedulerBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(SCHEDULER_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}
