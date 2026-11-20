import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';
import { QUEUE_OUTBOX_CONFIGURATION_SCHEMA } from './schemas/queue.outbox.configuration.js';

@Injectable(Bootstrapper)
export class QueueBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(QUEUE_OUTBOX_CONFIGURATION_SCHEMA);
  }
}
