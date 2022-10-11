import { ResolveException } from './../../di/src/exceptions';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { AsyncService, DI, IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IQueueConfiguration, QueueClient, QueueMessage, QueueJob } from './interfaces';

export * from './interfaces';
export * from './decorators';

export class Queues extends AsyncService {
  @Logger('queue')
  protected Log: Log;

  @Config('queue')
  protected Configuration: IQueueConfiguration;

  public async resolve(): Promise<void> {
    for (const c of this.Configuration.connections) {
      this.Log.trace(`Found queue ${c.name}, with transport: ${c.transport}, of type: ${c.type}`);

      DI.register(async (container: IContainer) => {
        if (!container.hasRegisteredType(QueueClient, c.transport)) {
          throw new ResolveException(`Queue client of type ${c.transport} is not registered in DI container.`);
        }

        return await container.resolve(QueueClient, [c]);
      }).as(`__queue__${c.name}`);
    }

    await super.resolve();
  }

  public async emit<T>(event: QueueMessage<T>) {
    const c = this.get(event.Connection);
    if (!c) {
      throw new UnexpectedServerError(`Queue ${event.Connection} not exists !`);
    }

    return c.emit(event);
  }

  public get(connection?: string) {
    return DI.get<QueueClient>(`__queue__${connection ?? this.Configuration.default}`);
  }
}
