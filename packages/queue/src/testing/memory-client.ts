import { Autoinject, Injectable, PerInstanceCheck } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { Clock } from '@spinajs/durable';
import { isCrash } from '../crash.js';
import { decideDelivery, resolveDeliveryPolicy, retryCountOf } from '../delivery.js';
import type { DeliveryDecision } from '../delivery.js';
import { QueueClient, QueueMessageType } from '../interfaces.js';
import { QueueHeaders } from '../headers.js';
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
  subscriptionId?: string;
  active: boolean;
}

interface PendingDelivery {
  message: IQueueMessage;
  channel: string;
  /** Events only: the subscriptions that rejected it and get it again. A job is re-queued for whoever consumes its channel. */
  owed?: MemorySubscription[];
  /** Clock time from which the delivery may be handed out. */
  availableAt: number;
  /** The transport headers of this copy, merged over the message's own `Headers` on delivery. */
  headers: Record<string, string>;
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
export { wire as wireCopy };

/** What a subscriber receives: the wire copy with the MessageId header and the transport headers of this copy. */
function delivered(message: IQueueMessage, headers: Record<string, string> = {}): IQueueMessage {
  const copy = wire(message);
  const all = { ...copy.Headers, ...headers, ...(copy.MessageId ? { [QueueHeaders.MessageId]: copy.MessageId } : {}) };
  if (Object.keys(all).length > 0) copy.Headers = all;
  return copy;
}

/** A transport without a server, for tests. It keeps what it was given as JSON, as a broker would. */
@PerInstanceCheck()
@Injectable(QueueClient)
export class MemoryQueueClient extends QueueClient {
  /** Every message this client accepted, in order. Append-only. */
  readonly published: IQueueMessage[] = [];

  /** Messages the transport dead-lettered. Deferred mode writes them when a decision dead-letters. */
  readonly deadLettered: { channel: string; message: IQueueMessage; headers: Record<string, string> }[] = [];

  /** @internal */
  subscriptions: MemorySubscription[] = [];

  @Autoinject(Clock)
  protected Timers: Clock;

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

  // only deferred mode executes a RedeliverLater as a later delivery; the default mode has nothing to redeliver from
  public get RedeliversFailedEvents(): boolean {
    return this.Deferred;
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
      for (const channel of this.getChannelForMessage(message)) this.broker.pending.push({ message, channel, availableAt: this.Timers.now(), headers: {} });
      return;
    }

    if (message.Type !== QueueMessageType.Event) return;
    for (const client of this.broker.clients) {
      for (const s of client.subscriptions) await s.callback(delivered(message));
    }
  }

  async subscribe(channel: string | Constructor<QueueMessage>, callback: Callback, subscriptionId?: string): Promise<void> {
    const channels = !this.Deferred ? [] : typeof channel === 'string' ? [channel] : this.getChannelForMessage(channel);
    this.subscriptions.push({ client: this, channels, callback, subscriptionId, active: true });
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
   * Deferred mode: delivers what the broker holds and is due on the injected `Clock`, in publish order, and settles a
   * delivery once its callback resolved. A rejected delivery is settled by the delivery decision: acked, dead-lettered
   * into `deadLettered`, or queued again until its delay has passed; a crash leaves it queued as it was. What is
   * published meanwhile waits for the next call. Default mode delivers during `emit()`, so there is nothing to do.
   */
  async deliverAll(): Promise<void> {
    if (!this.Deferred) return;

    const now = this.Timers.now();
    const held = this.broker.pending;
    this.broker.pending = [];
    const unsettled: PendingDelivery[] = [];
    for (const delivery of held) {
      if (delivery.availableAt > now) unsettled.push(delivery);
      else unsettled.push(...(await this.attempt(delivery)));
    }
    this.broker.pending = [...unsettled, ...this.broker.pending];
  }

  private targetsOf(delivery: PendingDelivery): MemorySubscription[] {
    if (delivery.owed) return delivery.owed.filter((s) => s.active);
    const subscribed = this.broker.subscriptionsOn(delivery.channel);
    if (delivery.message.Type === QueueMessageType.Job) return subscribed.slice(0, 1);
    // subscriptions that share a subscriptionId compete for one copy, as consumers of one durable queue do
    const taken = new Set<string>();
    return subscribed.filter((s) => {
      if (!s.subscriptionId) return true;
      if (taken.has(s.subscriptionId)) return false;
      taken.add(s.subscriptionId);
      return true;
    });
  }

  /** Returns what is still owed: retries, crashed copies, and a job nobody consumes yet. */
  private async attempt(delivery: PendingDelivery): Promise<PendingDelivery[]> {
    const targets = this.targetsOf(delivery);
    if (targets.length === 0) {
      // A queue holds a job until a consumer arrives; a topic drops an event nobody listens to.
      return !delivery.owed && delivery.message.Type === QueueMessageType.Job ? [delivery] : [];
    }

    const left: PendingDelivery[] = [];
    for (const target of targets) {
      const copy = delivered(delivery.message, delivery.headers);
      try {
        await target.callback(copy);
      } catch (err) {
        if (isCrash(err)) {
          // a dead consumer settles nothing: the broker hands the same copy out again
          left.push({ ...delivery, owed: this.owedTo(delivery, target) });
          continue;
        }
        const decision = decideDelivery(copy, retryCountOf(delivery.headers), err, resolveDeliveryPolicy(target.client, delivery.message));
        left.push(...this.execute(delivery, target, decision));
      }
    }
    return left;
  }

  private execute(delivery: PendingDelivery, target: MemorySubscription, decision: DeliveryDecision): PendingDelivery[] {
    const deadLetter = decision.action === 'dead-letter' ? `${decision.reason}, to ${decision.channel ?? 'no dead-letter channel'}` : undefined;
    target.client.Log?.warn({ messageName: delivery.message.Name, channel: delivery.channel, action: decision.action, deadLetter }, 'Memory delivery of ${messageName} on ${channel} failed, decided ${action}');
    if (decision.action === 'ack') return [];
    if (decision.action === 'dead-letter') {
      if (decision.channel) this.deadLettered.push({ channel: decision.channel, message: delivery.message, headers: { ...decision.headers, [QueueHeaders.OriginalDestination]: delivery.channel } });
      return [];
    }
    return [{ message: delivery.message, channel: delivery.channel, owed: this.owedTo(delivery, target), availableAt: this.Timers.now() + decision.delayMs, headers: { ...delivery.headers, ...decision.headers } }];
  }

  /** A job goes back to its queue for any consumer; an event copy is owed to the subscription that failed it. */
  private owedTo(delivery: PendingDelivery, target: MemorySubscription): MemorySubscription[] | undefined {
    return delivery.message.Type === QueueMessageType.Job ? undefined : [target];
  }
}
