import { UnexpectedServerError } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { AsyncModule, DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { QueueConfiguration, QueueClient, Message, Job } from './interfaces';

export * from './interfaces';
export * from './decorators';

export class Queues extends AsyncModule {
  @Logger('queue')
  protected Log: Log;

  @Config('queue')
  protected Configuration: QueueConfiguration;

  public async resolveAsync(): Promise<void> {
    for (const c of this.Configuration.connections) {
      this.Log.trace(`Found queue ${c.name}, with transport: ${c.transport}`);

      const connection = await DI.resolve(QueueClient, [c]);
      DI.register(connection).asValue(`__queue__${c.name}`);
    }

    await super.resolveAsync();
  }

  public async emit<T>(event: Message<T>) {
    const c = this.get(event.Connection);
    if (!c) {
      throw new UnexpectedServerError(`Queue ${event.Connection} not exists !`);
    }

    return await c.emit(event);
  }

  public async emitJob<T>(event: Job<T>) {
    const c = this.get(event.Connection);
    if (!c) {
      throw new UnexpectedServerError(`Queue ${event.Connection} not exists !`);
    }

    return await c.emitJob(event);
  }

  public get(connection: string) {
    return DI.get<QueueClient>(`__queue__${connection}`);
  }
}
