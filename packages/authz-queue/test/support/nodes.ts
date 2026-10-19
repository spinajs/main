import { QueueService } from '@spinajs/queue';
import type { IQueueMessage, QueueMessage as QueueMessageBase } from '@spinajs/queue';

import { QueueChangeBus } from '../../src/index.js';
import type { MemoryQueueClient } from './memory-client.js';

/** The bus of a node; `ready()` resolves once it listens on the queue. */
export class NodeBus extends QueueChangeBus {
  constructor(private readonly service?: QueueService) {
    super();
  }

  ready(): Promise<unknown> {
    return this.start();
  }

  protected async queueService(): Promise<QueueService> {
    return this.service ?? super.queueService();
  }
}

/** The QueueService of a second node: the same broker, a client of its own. */
export class PeerQueueService extends QueueService {
  constructor(readonly client: MemoryQueueClient) {
    super();
  }

  async emit(event: IQueueMessage): Promise<string | undefined> {
    await this.client.emit(event);
    return undefined;
  }

  async consume<T extends QueueMessageBase>(event: new () => QueueMessageBase, callback?: (message: T) => Promise<void>): Promise<void> {
    await this.client.subscribe(event as never, async (m) => {
      if (m.Name !== event.name) return;
      const message = new event();
      message.hydrate(m);
      await callback?.(message as T);
    });
  }

  async stopConsuming(): Promise<void> {
    this.client.unsubscribe();
  }

  get(): MemoryQueueClient {
    return this.client;
  }
}
