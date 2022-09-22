import { UnexpectedServerError } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { AsyncService, DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { QueueConfiguration, QueueClient, Message, Job } from './interfaces';

export * from './interfaces';
export * from './decorators';

export class Queues extends AsyncService {
  @Logger('queue')
  protected Log: Log;

  @Config('queue')
  protected Configuration: QueueConfiguration;

  public async resolve(): Promise<void> {
    for (const c of this.Configuration.connections) {
      this.Log.trace(`Found queue ${c.name}, with transport: ${c.transport}`);

      const connection = await DI.resolve(QueueClient, [c]);
      DI.register(connection).asValue(`__queue__${c.name}`);
    }

    await super.resolve();
  }

  public async emit<T>(event: Message<T>) {
    const c = this.get(event.Connection);
    if (!c) {
      throw new UnexpectedServerError(`Queue ${event.Connection} not exists !`);
    }

    // if not emitting locally, do it !
    // reasoning for this is for example
    // that we want to perform some local action on event eg. user creation that have
    // remote queue server for other microservices, but we also want to do something
    // with it in same process that emit it
    // and instead using remote server or emitting twice explicit ( one to remote, one to local)
    // subscribe it locally
    if (c.Options.name !== 'local') {
      return await Promise.all([c.emit(event), this.get('local').emit(event)]);
    }

    return c.emit(event);
  }

  public async emitJob<T>(event: Job<T>) {
    const c = this.get(event.Connection);
    if (!c) {
      throw new UnexpectedServerError(`Queue ${event.Connection} not exists !`);
    }

    return await c.emitJob(event);
  }

  public get(connection?: string) {
    return DI.get<QueueClient>(`__queue__${connection ?? this.Configuration.default}`);
  }
}
