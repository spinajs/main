import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';
import { IQueueMessage, QueueClient, QueueMessage } from '@spinajs/queue';

/** Broker-free transport: records emits and hands them to subscribers like a broker would. */
@PerInstanceCheck()
@Injectable(QueueClient)
export class InMemoryQueueClient extends QueueClient {
  public static Emitted: IQueueMessage[] = [];
  public static failNext = false;
  public static Subscribers = new Map<string, (e: IQueueMessage) => Promise<void>>();

  public emit(event: IQueueMessage): Promise<void> {
    if (InMemoryQueueClient.failNext) {
      InMemoryQueueClient.failNext = false;
      return Promise.reject(new Error('broker unavailable'));
    }
    InMemoryQueueClient.Emitted.push(event);
    const sub = InMemoryQueueClient.Subscribers.get(event.Name);
    // a broker delivers later and never surfaces consumer failures to the producer
    if (sub) setImmediate(() => void sub(event).catch(() => undefined));
    return Promise.resolve();
  }

  public subscribe(
    channel: string | Constructor<QueueMessage>,
    callback: (e: IQueueMessage) => Promise<void>,
  ): Promise<void> {
    InMemoryQueueClient.Subscribers.set(typeof channel === 'string' ? channel : channel.name, callback);
    return Promise.resolve();
  }

  public unsubscribe(): void {
    InMemoryQueueClient.Subscribers.clear();
  }

  public static reset(): void {
    InMemoryQueueClient.Emitted = [];
    InMemoryQueueClient.failNext = false;
    InMemoryQueueClient.Subscribers.clear();
  }
}

/** Shipped queue config concatenates its black-hole connection; `default` points every message here. */
export function queueConfig() {
  return {
    queue: {
      default: 'memory',
      routing: {},
      connections: [
        {
          name: 'memory',
          service: 'InMemoryQueueClient',
          defaultQueueChannel: '/queue/test',
          defaultTopicChannel: '/topic/test',
        },
      ],
    },
  };
}
