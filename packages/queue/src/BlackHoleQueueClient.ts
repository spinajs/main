import { Injectable, NewInstance } from '@spinajs/di';
import { IQueueMessage, QueueClient } from './interfaces';

/**
 * Empty queue, does nothing.
 * Use it, if you want to route or dismiss messages sent by queue service
 */
@NewInstance()
@Injectable()
export class BlackHoleQueueClient extends QueueClient {
  public emit(_event: IQueueMessage): Promise<void> {
    return Promise.resolve();
  }
  public subscribe(_channel: string, _callback: (e: IQueueMessage) => Promise<void>, _subscriptionId?: string, _durable?: boolean): Promise<void> {
    return Promise.resolve();
  }
  public unsubscribe(_channel: string): void {}
}
