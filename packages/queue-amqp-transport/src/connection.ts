import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';
import { IQueueMessage, IQueueConnectionOptions, QueueClient, QueueMessage } from '@spinajs/queue';
import amqp, { Channel, ChannelModel, ConsumeMessage, Options } from 'amqplib';
import _ from 'lodash';
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';

/**
 * Default prefix that marks a channel as a topic ( pub-sub / fanout exchange ).
 * Every other channel is treated as a durable work queue ( single consumer, job semantics ).
 *
 * This keeps parity with the STOMP transport convention of `/topic/...` vs `/queue/...`.
 */
const DEFAULT_TOPIC_PREFIX = '/topic/';

interface ISubscription {
  consumerTag: string;

  /**
   * Name of the broker queue the consumer is attached to.
   * For topics this is the ( possibly server generated ) queue bound to the fanout exchange.
   */
  queue: string;

  /**
   * Was the subscription created as durable.
   */
  durable: boolean;
}

@PerInstanceCheck()
@Injectable(QueueClient)
export class AmqpQueueClient extends QueueClient {
  protected Connection: ChannelModel;

  protected Channel: Channel;

  protected Subscriptions = new Map<string, ISubscription>();

  // destinations already declared on the broker, so we assert each one only once
  // instead of on every publish ( assert is a network round-trip ).
  protected AssertedQueues = new Set<string>();

  protected AssertedExchanges = new Set<string>();

  public get ClientId() {
    return this.Options.clientId ?? this.Options.name;
  }

  protected get TopicPrefix() {
    return (this.Options.options?.topicPrefix as string) ?? DEFAULT_TOPIC_PREFIX;
  }

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  public async resolve() {
    this.Log.info(`Connecting to AMQP queue at ${this.Options.host ?? 'localhost'} with client-id: ${this.ClientId} ...`);

    try {
      // when host is a full url ( eg. amqp://user:pass@host/vhost ) use it as is,
      // otherwise build a connect-options object from discrete fields.
      const url: string | Options.Connect =
        this.Options.host && this.Options.host.includes('://')
          ? this.Options.host
          : {
              protocol: 'amqp',
              hostname: this.Options.host ?? 'localhost',
              port: this.Options.port ?? 5672,
              username: this.Options.login,
              password: this.Options.password,
              vhost: this.Options.options?.vhost ?? '/',
            };

      this.Connection = await amqp.connect(url as any, {
        clientProperties: { connection_name: this.ClientId },
        // allow caller provided socket options ( heartbeat, tls etc. )
        ...this.Options.options,
      });
    } catch (err) {
      throw new UnexpectedServerError(`Cannot connect to AMQP queue server at ${this.Options.host ?? 'localhost'}`, err);
    }

    this.Connection.on('error', (err) => {
      this.Log.error(`AMQP connection error, client-id: ${this.ClientId}, name: ${this.Options.name}: ${err?.message}`);
    });

    this.Connection.on('close', () => {
      this.Log.warn(`AMQP connection closed, client-id: ${this.ClientId}, name: ${this.Options.name}`);
    });

    this.Channel = await this.Connection.createChannel();

    // limit in-flight unacked messages per consumer. Defaults to 1 ( fair dispatch, mirrors STOMP
    // `activemq.prefetchSize: 1` so a busy consumer does not hog the queue ). Raise via options.prefetch
    // to trade fairness for throughput on work queues.
    await this.Channel.prefetch(this.Options.options?.prefetch ?? 1);

    this.Log.success(`Connected to AMQP broker, client-id: ${this.ClientId}`);
  }

  public async dispose() {
    this.Log.info(`Disposing queue connection ${this.Options.name} ...`);

    try {
      if (this.Channel) {
        await this.Channel.close();
      }
    } catch (err) {
      this.Log.warn(`Error while closing AMQP channel for ${this.Options.name}: ${err?.message}`);
    }

    try {
      if (this.Connection) {
        await this.Connection.close();
      }
    } catch (err) {
      this.Log.warn(`Error while closing AMQP connection for ${this.Options.name}: ${err?.message}`);
    }

    this.Subscriptions.clear();

    this.Log.success(`AMQP connection ${this.Options.name} disposed`);
  }

  public async emit(message: IQueueMessage) {
    this.warnOnUnsupportedScheduling(message);

    const channels = this.getChannelForMessage(message);
    const buffer = Buffer.from(JSON.stringify(message));

    const publishOptions: Options.Publish = {
      persistent: !!message.Persistent,
      contentType: 'application/json',
    };

    if (message.Priority) {
      publishOptions.priority = message.Priority;
    }

    for (const c of channels) {
      if (this.isTopic(c)) {
        await this.assertExchange(c);
        this.Channel.publish(c, '', buffer, publishOptions);
      } else {
        await this.assertQueue(c);
        this.Channel.sendToQueue(c, buffer, publishOptions);
      }

      this.Log.trace(`Published ${message.Type} Name: ${message.Name} to channel ${c} ( ${this.Options.name} )`);
    }
  }

  public async subscribe(channelOrMessage: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void> {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    for (const c of channels) {
      if (this.Subscriptions.has(c)) {
        this.Log.warn(`Channel ${c} already subscribed !`);
        continue;
      }

      const queue = await this.assertSubscriptionQueue(c, subscriptionId, durable);

      const { consumerTag } = await this.Channel.consume(
        queue,
        (msg: ConsumeMessage | null) => {
          // null is delivered when the consumer is cancelled by the broker
          if (!msg) {
            return;
          }

          let qMessage: IQueueMessage;
          try {
            qMessage = JSON.parse(msg.content.toString()) as IQueueMessage;
          } catch (err) {
            this.Log.error(`Cannot parse incoming message on channel ${c}, dropping it: ${err?.message}`);
            // malformed message, do not requeue
            this.Channel.nack(msg, false, false);
            return;
          }

          callback(qMessage)
            .then(() => {
              this.Channel.ack(msg);
            })
            .catch((err) => {
              this.Log.error(err, `Error while processing message on channel ${c}`);
              // do not requeue to avoid poison-message loops; dead-lettering is configured on the broker
              this.Channel.nack(msg, false, false);
            });
        },
        { noAck: false },
      );

      this.Subscriptions.set(c, { consumerTag, queue, durable: !!durable });

      this.Log.success(`Channel ${c}, durable: ${durable ? 'true' : 'false'} subscribed and ready to receive messages !`);
    }
  }

  public unsubscribe(channelOrMessage: string | Constructor<QueueMessage>): void {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    for (const c of channels) {
      const sub = this.Subscriptions.get(c);
      if (!sub) {
        continue;
      }

      this.Subscriptions.delete(c);

      // cancel only the consumer. For durable subscriptions the bound queue is left in place
      // so messages keep accumulating while no consumer is attached ( same semantics as STOMP durable subs ).
      this.Channel.cancel(sub.consumerTag).catch((err) => {
        this.Log.warn(`Error while cancelling consumer for channel ${c}: ${err?.message}`);
      });
    }
  }

  /**
   * Declares ( and for topics binds ) the broker queue a subscription should consume from.
   *
   * - work queue ( job ): durable queue named after the channel, shared by all consumers.
   * - topic ( event ): fanout exchange + a queue bound to it.
   *     - durable subscription: stable, durable, named ( subscriptionId ) queue that survives reconnects.
   *     - transient subscription: exclusive, auto-deleted, server-named queue.
   *
   * @returns name of the queue to consume from
   */
  protected async assertSubscriptionQueue(channel: string, subscriptionId?: string, durable?: boolean): Promise<string> {
    if (!this.isTopic(channel)) {
      return this.assertQueue(channel);
    }

    await this.assertExchange(channel);

    let queueName: string;

    if (durable) {
      if (!subscriptionId) {
        throw new InvalidArgument(`subscriptionId cannot be empty if using durable subscriptions`);
      }

      const q = await this.Channel.assertQueue(subscriptionId, { durable: true, exclusive: false, autoDelete: false });
      queueName = q.queue;
    } else {
      // server-named, exclusive, auto-deleted queue ( unique per subscriber )
      const q = await this.Channel.assertQueue(subscriptionId ?? '', { durable: false, exclusive: !subscriptionId, autoDelete: true });
      queueName = q.queue;
    }

    await this.Channel.bindQueue(queueName, channel, '');

    return queueName;
  }

  /**
   * Declares a durable work queue, asserting it on the broker only once.
   * @returns the queue name
   */
  protected async assertQueue(name: string): Promise<string> {
    if (!this.AssertedQueues.has(name)) {
      await this.Channel.assertQueue(name, { durable: true });
      this.AssertedQueues.add(name);
    }

    return name;
  }

  /**
   * Declares a durable fanout exchange, asserting it on the broker only once.
   */
  protected async assertExchange(name: string): Promise<void> {
    if (!this.AssertedExchanges.has(name)) {
      await this.Channel.assertExchange(name, 'fanout', { durable: true });
      this.AssertedExchanges.add(name);
    }
  }

  protected isTopic(channel: string): boolean {
    return channel.startsWith(this.TopicPrefix);
  }

  protected warnOnUnsupportedScheduling(message: IQueueMessage) {
    if (message.ScheduleDelay || message.ScheduleCron || message.SchedulePeriod || message.ScheduleRepeat) {
      this.Log.warn(`Message ${message.Name} has scheduling options set, but the AMQP transport does not support delayed/scheduled delivery yet. Message will be delivered immediately.`);
    }
  }
}
