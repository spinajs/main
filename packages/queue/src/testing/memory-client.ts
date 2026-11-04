import { Injectable, PerInstanceCheck } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { QueueClient, QueueMessageType } from '../interfaces.js';
import type { IQueueMessage, QueueMessage } from '../interfaces.js';

type Callback = (e: IQueueMessage) => Promise<void>;

export interface IMemoryQueueClientOptions {
  /** Clients that name the same broker share its subscribers. Default `'default'`. */
  broker?: string;

  /**
   * `false` (default): an event reaches every subscriber of the broker during `emit()`, a job only through `deliver()`.
   * `true`: `emit()` only queues, `deliverAll()` delivers and settles, by channel, as a broker would.
   */
  deferred?: boolean;
}

interface MemorySubscription {
  client: MemoryQueueClient;
  /** Resolved only in deferred mode; the default mode ignores channels. */
  channels: string[];
  callback: Callback;
  active: boolean;
}

interface PendingDelivery {
  message: IQueueMessage;
  channel: string;
  /** Subscriptions still owed this message: set once it reached its first subscriber, narrowed to the failed ones on a retry. */
  owed?: MemorySubscription[];
}

/** Connects the clients that share one broker name. */
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

  /** Deferred-mode deliveries not settled yet, in publish order. */
  pending: PendingDelivery[] = [];

  subscriptionsOn(channel: string): MemorySubscription[] {
    return [...this.clients].flatMap((c) => c.subscriptions.filter((s) => s.active && s.channels.includes(channel)));
  }
}

function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A transport without a server, for tests. It keeps what it was given as JSON, as a broker would. */
@PerInstanceCheck()
@Injectable(QueueClient)
export class MemoryQueueClient extends QueueClient {
  /** Every message this client accepted, in order. Append-only. */
  readonly published: IQueueMessage[] = [];

  /** Filled by the delivery contract (O4); empty until then. */
  readonly deadLettered: { channel: string; message: IQueueMessage; headers: Record<string, string> }[] = [];

  /** @internal */
  subscriptions: MemorySubscription[] = [];

  private broker: MemoryBroker;

  /** Alias of {@link MemoryQueueClient.published}. */
  get Emitted(): IQueueMessage[] {
    return this.published;
  }

  protected get MemoryOptions(): IMemoryQueueClientOptions {
    return (this.Options.options as IMemoryQueueClientOptions | undefined) ?? {};
  }

  get Deferred(): boolean {
    return this.MemoryOptions.deferred === true;
  }

  async resolve(): Promise<void> {
    this.broker = MemoryBroker.named(this.MemoryOptions.broker ?? 'default');
    this.broker.clients.add(this);
    await super.resolve();
  }

  async dispose(): Promise<void> {
    this.broker?.clients.delete(this);
    this.unsubscribe();
  }

  async emit(event: IQueueMessage): Promise<void> {
    const message = wire(event);
    this.published.push(message);

    if (this.Deferred) {
      for (const channel of this.getChannelForMessage(message)) this.broker.pending.push({ message, channel });
      return;
    }

    if (message.Type !== QueueMessageType.Event) return;
    for (const client of this.broker.clients) {
      for (const s of client.subscriptions) await s.callback(wire(message));
    }
  }

  async subscribe(channel: string | Constructor<QueueMessage>, callback: Callback): Promise<void> {
    const channels = !this.Deferred ? [] : typeof channel === 'string' ? [channel] : this.getChannelForMessage(channel);
    this.subscriptions.push({ client: this, channels, callback, active: true });
  }

  unsubscribe(): void {
    for (const s of this.subscriptions) s.active = false;
    this.subscriptions = [];
  }

  /** Hands a message to this client's subscribers, as the broker would a job. */
  async deliver(event: IQueueMessage): Promise<void> {
    for (const s of this.subscriptions) await s.callback(event);
  }

  /**
   * Deferred mode: delivers what the broker holds, in publish order, and settles a delivery once its callback resolved.
   * A rejected delivery stays queued for the next call; what is published meanwhile waits for the next call too.
   * Default mode delivers during `emit()`, so there is nothing to do.
   */
  async deliverAll(): Promise<void> {
    if (!this.Deferred) return;

    const batch = this.broker.pending;
    this.broker.pending = [];
    const unsettled: PendingDelivery[] = [];
    for (const delivery of batch) {
      const left = await this.attempt(delivery);
      if (left) unsettled.push(left);
    }
    this.broker.pending = [...unsettled, ...this.broker.pending];
  }

  private targetsOf(delivery: PendingDelivery): MemorySubscription[] {
    if (delivery.owed) return delivery.owed.filter((s) => s.active);
    const subscribed = this.broker.subscriptionsOn(delivery.channel);
    return delivery.message.Type === QueueMessageType.Job ? subscribed.slice(0, 1) : subscribed;
  }

  /** Returns the delivery still owed to someone, or undefined once it is settled or has nowhere to go. */
  private async attempt(delivery: PendingDelivery): Promise<PendingDelivery | undefined> {
    const targets = this.targetsOf(delivery);
    if (targets.length === 0) {
      // A queue holds a job until a consumer arrives; a topic drops an event nobody listens to.
      return !delivery.owed && delivery.message.Type === QueueMessageType.Job ? delivery : undefined;
    }

    const failed: MemorySubscription[] = [];
    for (const target of targets) {
      try {
        await target.callback(wire(delivery.message));
      } catch (err) {
        failed.push(target);
        target.client.Log?.warn({ error: err, channel: delivery.channel, messageName: delivery.message.Name }, 'Memory delivery of ${messageName} on ${channel} failed, it stays queued');
      }
    }

    return failed.length > 0 ? { ...delivery, owed: failed } : undefined;
  }
}
