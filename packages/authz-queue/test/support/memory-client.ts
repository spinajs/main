import { Injectable, PerInstanceCheck } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { QueueClient, QueueMessageType } from '@spinajs/queue';
import type { IQueueMessage, QueueMessage } from '@spinajs/queue';

/** Connects the clients that share one name of broker; events fan out to all of them. */
export class MemoryBroker {
  private static readonly brokers = new Map<string, MemoryBroker>();

  static named(name: string): MemoryBroker {
    let b = MemoryBroker.brokers.get(name);
    if (!b) MemoryBroker.brokers.set(name, (b = new MemoryBroker()));
    return b;
  }

  static drop(name: string): void {
    MemoryBroker.brokers.delete(name);
  }

  readonly clients = new Set<MemoryQueueClient>();
}

type Callback = (e: IQueueMessage) => Promise<void>;

/** A transport without a server. It keeps what it was given as JSON, as a broker would. */
@PerInstanceCheck()
@Injectable(QueueClient)
export class MemoryQueueClient extends QueueClient {
  readonly Emitted: IQueueMessage[] = [];
  private callbacks: Callback[] = [];
  private broker: MemoryBroker;

  async resolve(): Promise<void> {
    this.broker = MemoryBroker.named((this.Options.options as { broker?: string } | undefined)?.broker ?? 'default');
    this.broker.clients.add(this);
    await super.resolve();
  }

  async dispose(): Promise<void> {
    this.broker?.clients.delete(this);
    this.callbacks = [];
  }

  async emit(event: IQueueMessage): Promise<void> {
    const wire = JSON.parse(JSON.stringify(event)) as IQueueMessage;
    this.Emitted.push(wire);
    if (wire.Type !== QueueMessageType.Event) return;

    for (const client of this.broker.clients) {
      for (const cb of client.callbacks) await cb(JSON.parse(JSON.stringify(wire)) as IQueueMessage);
    }
  }

  async subscribe(_channel: string | Constructor<QueueMessage>, callback: Callback): Promise<void> {
    this.callbacks.push(callback);
  }

  unsubscribe(): void {
    this.callbacks = [];
  }

  /** Hands a message to this client's subscribers, as the broker would a job. */
  async deliver(event: IQueueMessage): Promise<void> {
    for (const cb of this.callbacks) await cb(event);
  }
}
