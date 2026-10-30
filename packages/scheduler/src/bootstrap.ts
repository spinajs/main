import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { CONFIGURATION_SCHEMA } from '@spinajs/configuration';
import { SCHEDULER_CONFIGURATION_SCHEMA } from './schemas/scheduler.configuration.js';

@Injectable(Bootstrapper)
export class SchedulerBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(SCHEDULER_CONFIGURATION_SCHEMA).asValue(CONFIGURATION_SCHEMA.key);
  }
}
