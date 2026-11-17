import { Configuration, registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { QueueService } from './interfaces.js';
import { outboxConfig, type IQueueOutboxConfig } from './outbox/config.js';
import { QUEUE_CONFIGURATION_SCHEMA } from './schemas/queue.configuration.js';
import { QUEUE_OUTBOX_CONFIGURATION_SCHEMA } from './schemas/queue.outbox.configuration.js';

/** Resolves the queue service an enabled outbox needs without waiting for a first emit; undefined while the outbox is off. */
export async function startOutboxService(): Promise<QueueService | undefined> {
  const configuration = await DI.resolve(Configuration);
  const outbox = outboxConfig(configuration.get<Partial<IQueueOutboxConfig> | undefined>('queue.outbox'));
  return outbox.enabled ? DI.resolve(QueueService) : undefined;
}

@Injectable(Bootstrapper)
export class QueueBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(QUEUE_OUTBOX_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(QUEUE_CONFIGURATION_SCHEMA);
    // The Orm is cached when this fires, so the queue service can resolve what injects it. A listener has no caller to
    // reject, so a failure is logged; the failures that must stop the boot are thrown by QueueOutboxMigrationSource.
    DI.once('di.resolved.Orm', () => {
      startOutboxService().catch((error: unknown) => DI.resolve(Log, ['queue']).error({ error }, 'The queue service an enabled outbox needs could not be resolved at boot'));
    });
  }
}
