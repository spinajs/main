import { Injectable } from '@spinajs/di';
import { EventEmitter } from 'eventemitter3';
import { QueueMessage, QueueJob, QueueClient } from './interfaces';

@Injectable('local-event-emitter')
export class LocalQueueClient extends QueueClient {
  protected Emitter = new EventEmitter();

  public async emit<T>(event: QueueMessage<T>): Promise<boolean> {
    this.Emitter.emit(`__event__${event.Name}`, event);
    return true;
  }

  public async resolve(): Promise<void> {
    this.Emitter.on('__job__', async (m: QueueJob<unknown>) => {
      if (m.Delay > 0) {
        setTimeout(execute, m.Delay);
      } else {
        execute();
      }

      async function execute() {
        let i = 0;
        while (i < m.RetryCount) {
          try {
            const result = await m.execute();
            if (result) {
              return;
            }

            i++;
            this.Log.warn(`Executing job ${m.Name}, class: ${m.constructor.name}, failed, retry count: ${i}/${m.RetryCount}`);
          } catch (err) {
            this.Log.error(err, `Unexpected error executing job ${m.Name}, class: ${m.constructor.name}, reason: ${err.message}`);
          }
        }
      }
    });
  }

  public async subscribe<T>(event: string, callback: (e: QueueMessage<T>) => Promise<boolean>): Promise<void> {
    this.Emitter.on(`__event__${event}`, callback);
  }

  public async unsubscribe<T>(event: string, callback: (e: QueueMessage<T>) => Promise<boolean>): Promise<void> {
    this.Emitter.off(`__event__${event}`, callback);
  }
}
