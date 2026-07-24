import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';
import { IQueueMessage, IQueueJob, IQueueConnectionOptions, QueueClient, QueueMessage, QueueMessageType } from '@spinajs/queue';
import amqp, { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import _ from 'lodash';
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder } from '@spinajs/util';

/**
 * Default prefix that marks a channel as a topic ( pub-sub / fanout exchange ).
 * Every other channel is treated as a durable work queue ( single consumer, job semantics ).
 *
 * This keeps parity with the STOMP transport convention of `/topic/...` vs `/queue/...`.
 */
const DEFAULT_TOPIC_PREFIX = '/topic/';

/** Header carrying the retry attempt count across redeliveries. */
const RETRY_COUNT_HEADER = 'x-retry-count';

/**
 * Everything needed to re-establish a subscription after a reconnect. amqplib consumers do not
 * survive a dropped connection, so we keep descriptors and replay them on every (re)connect.
 */
interface ISubscriptionDescriptor {
  channel: string;
  callback: (e: IQueueMessage) => Promise<void>;
  subscriptionId?: string;
  durable: boolean;
  /** Runtime state - refreshed on every (re)connect. */
  consumerTag?: string;
  queue?: string;
}

interface IPendingEmit {
  message: IQueueMessage;
  resolve: () => void;
  reject: (err: unknown) => void;
}

@PerInstanceCheck()
@Injectable(QueueClient)
export class AmqpQueueClient extends QueueClient {
  protected Connection: ChannelModel;

  /** Confirm channel used for publishing so emit() resolves only after a broker ack. */
  protected PublishChannel: ConfirmChannel;

  /** Separate channel for consumers so publisher back-pressure cannot stall consumer acks. */
  protected ConsumeChannel: Channel;

  protected Subscriptions = new Map<string, ISubscriptionDescriptor>();

  // destinations already declared on the broker, so we assert each one only once per connection
  // ( assert is a network round-trip ). Cleared on reconnect because channels are recreated.
  protected AssertedQueues = new Set<string>();
  protected AssertedExchanges = new Set<string>();
  protected AssertedRetryQueues = new Set<string>();

  /** Messages emitted while disconnected - flushed on (re)connect. */
  protected PendingEmits: IPendingEmit[] = [];

  protected Connected = false;
  protected Disposing = false;
  protected ReconnectTimer?: ReturnType<typeof setTimeout>;

  /** Publisher-side resilience: time-bound + retry each publish so transient broker hiccups
   * don't lose an emit. Safe against the resulting duplicates because consumers dedupe by JobId. */
  protected EmitPipeline: ResiliencePipeline<void> = this.buildEmitPipeline();

  public get ClientId() {
    return this.Options.clientId ?? this.Options.name;
  }

  protected get TopicPrefix() {
    return (this.Options.options?.topicPrefix as string) ?? DEFAULT_TOPIC_PREFIX;
  }

  protected get ReconnectDelay() {
    return this.Options.reconnectDelay ?? 5000;
  }

  protected get Prefetch() {
    return (this.Options.options?.prefetch as number) ?? 1;
  }

  public get IsConnected() {
    return this.Connected;
  }

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  public async resolve() {
    await this.connect();
  }

  /**
   * Creates the underlying amqplib connection. Isolated as a seam so tests can inject a fake
   * broker without a real server ( mirrors the STOMP transport's createClient seam ).
   */
  protected createConnection(url: string | Options.Connect, socketOptions: Record<string, unknown>): Promise<ChannelModel> {
    return amqp.connect(url as any, socketOptions);
  }

  /**
   * Builds the amqplib connection target from the configured options.
   *
   * A url-style host ( `amqp://.../vhost` ) is parsed into an explicit {@link Options.Connect}
   * object rather than passed as a raw string, so every setting - crucially the credentials - is a
   * clear field instead of being buried in the url. amqplib derives credentials for a *string* url
   * only from the url's own userinfo, which is why the discrete `login` / `password` config fields
   * were previously ignored for a url host. Credentials embedded in the url still win; the config
   * fields are the fallback when the url carries none ( matching amqplib's own precedence ).
   */
  protected buildConnectionTarget(): Options.Connect {
    const host = this.Options.host;

    // discrete-fields host ( no scheme ) - build straight from the individual config fields
    if (!host || !host.includes('://')) {
      return this.connectOptionsFromFields(host ?? 'localhost');
    }

    let parsed: URL;
    try {
      parsed = new URL(host);
    } catch {
      // not a parseable url - treat the whole value as a bare hostname and use the config fields
      return this.connectOptionsFromFields(host);
    }

    const protocol = parsed.protocol.replace(/:$/, '') || 'amqp';

    // amqplib treats the url's credentials as authoritative when it carries either field; only when
    // it carries neither do we fall back to the login / password config fields.
    const urlHasCredentials = parsed.username !== '' || parsed.password !== '';

    const target: Options.Connect = {
      protocol,
      // strip IPv6 brackets - amqplib uses hostname verbatim as the socket host in object mode
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port ? Number(parsed.port) : this.Options.port ?? (protocol === 'amqps' ? 5671 : 5672),
      username: urlHasCredentials ? decodeURIComponent(parsed.username) : this.Options.login,
      password: urlHasCredentials ? decodeURIComponent(parsed.password) : this.Options.password,
      // keep the vhost percent-encoded - amqplib unescapes it exactly once ( decoding here too would
      // double-decode, eg. %2f -> / -> wrong vhost ). An empty path keeps the broker default.
      vhost: parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.slice(1) : '/',
    };

    // connection tuning params live in the url query string in string-mode; carry the ones amqplib
    // understands over so switching to object-mode does not silently drop them.
    const heartbeat = parsed.searchParams.get('heartbeat');
    const frameMax = parsed.searchParams.get('frameMax');
    const locale = parsed.searchParams.get('locale');
    if (heartbeat !== null) target.heartbeat = Number(heartbeat);
    if (frameMax !== null) target.frameMax = Number(frameMax);
    if (locale !== null) target.locale = locale;

    return target;
  }

  /** Connect-options object built from the discrete `host` / `port` / `login` / `password` fields. */
  protected connectOptionsFromFields(hostname: string): Options.Connect {
    return {
      protocol: 'amqp',
      hostname,
      port: this.Options.port ?? 5672,
      username: this.Options.login,
      password: this.Options.password,
      vhost: this.Options.options?.vhost ?? '/',
    };
  }

  public async dispose() {
    this.Log.info(`Disposing queue connection ${this.Options.name} ...`);

    this.Disposing = true;
    if (this.ReconnectTimer) {
      clearTimeout(this.ReconnectTimer);
      this.ReconnectTimer = undefined;
    }

    await this.closeChannel(this.PublishChannel);
    await this.closeChannel(this.ConsumeChannel);

    try {
      if (this.Connection) {
        await this.Connection.close();
      }
    } catch (err) {
      this.Log.warn(`Error while closing AMQP connection for ${this.Options.name}: ${err?.message}`);
    }

    this.Connected = false;
    this.Subscriptions.clear();

    this.Log.success(`AMQP connection ${this.Options.name} disposed`);
  }

  /**
   * Establishes the connection + channels, then replays subscriptions and flushes buffered emits.
   * Called on initial resolve and on every reconnect.
   */
  protected async connect() {
    this.Log.info(`Connecting to AMQP queue at ${this.Options.host ?? 'localhost'} with client-id: ${this.ClientId} ...`);

    // channels are recreated - forget what the previous ( dead ) channels had asserted
    this.AssertedQueues.clear();
    this.AssertedExchanges.clear();
    this.AssertedRetryQueues.clear();

    try {
      // resolve the connection target from config. A url-style host is parsed into an explicit
      // Options.Connect object ( see buildConnectionTarget ) so the credentials and every other
      // setting are clear fields instead of being hidden inside a url string.
      const url = this.buildConnectionTarget();

      this.Connection = await this.createConnection(url, {
        clientProperties: { connection_name: this.ClientId },
        ...this.Options.options,
      });
    } catch (err) {
      throw new UnexpectedServerError(`Cannot connect to AMQP queue server at ${this.Options.host ?? 'localhost'}`, err);
    }

    this.Connection.on('error', (err) => {
      this.Log.error(`AMQP connection error, client-id: ${this.ClientId}, name: ${this.Options.name}: ${err?.message}`);
    });

    this.Connection.on('close', () => {
      this.onConnectionLost();
    });

    // confirm channel for publishing ( emit() waits for the broker ack ), plain channel for consuming
    this.PublishChannel = await this.Connection.createConfirmChannel();
    this.ConsumeChannel = await this.Connection.createChannel();

    // limit in-flight unacked messages per consumer. Defaults to 1 ( fair dispatch, mirrors STOMP
    // `activemq.prefetchSize: 1` ). Raise via options.prefetch to trade fairness for throughput.
    await this.ConsumeChannel.prefetch(this.Prefetch);

    this.Connected = true;
    this.Log.success(`Connected to AMQP broker, client-id: ${this.ClientId}`);

    await this.replaySubscriptions();
    await this.flushPendingEmits();
  }

  /**
   * Handles an unexpected connection drop by scheduling a reconnect ( unless we are disposing ).
   */
  protected onConnectionLost() {
    if (this.Disposing || !this.Connected) {
      return;
    }

    this.Connected = false;
    this.Log.warn(`AMQP connection ${this.Options.name} lost, scheduling reconnect in ${this.ReconnectDelay}ms`);
    this.scheduleReconnect();
  }

  protected scheduleReconnect() {
    if (this.ReconnectTimer || this.Disposing) {
      return;
    }

    this.ReconnectTimer = setTimeout(() => {
      this.ReconnectTimer = undefined;
      this.connect().catch((err) => {
        this.Log.error(`AMQP reconnect for ${this.Options.name} failed: ${err?.message}. Retrying in ${this.ReconnectDelay}ms`);
        this.scheduleReconnect();
      });
    }, this.ReconnectDelay);
  }

  public async emit(message: IQueueMessage) {
    this.warnOnUnsupportedScheduling(message);

    // buffer while disconnected so callers can emit during a reconnect window
    if (!this.Connected) {
      return new Promise<void>((resolve, reject) => {
        this.PendingEmits.push({ message, resolve, reject });
      });
    }

    return this.publishMessage(message);
  }

  public async subscribe(channelOrMessage: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void> {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    for (const c of channels) {
      if (this.Subscriptions.has(c)) {
        this.Log.warn(`Channel ${c} already subscribed !`);
        continue;
      }

      const descriptor: ISubscriptionDescriptor = { channel: c, callback, subscriptionId, durable: !!durable };
      this.Subscriptions.set(c, descriptor);

      await this.startConsumer(descriptor);
    }
  }

  public unsubscribe(channelOrMessage: string | Constructor<QueueMessage>, _removeDurable?: boolean): void {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    for (const c of channels) {
      const sub = this.Subscriptions.get(c);
      if (!sub) {
        continue;
      }

      this.Subscriptions.delete(c);

      // cancel only the consumer. For durable subscriptions the bound queue is left in place
      // so messages keep accumulating while no consumer is attached ( same semantics as STOMP ).
      if (sub.consumerTag) {
        this.ConsumeChannel.cancel(sub.consumerTag).catch((err) => {
          this.Log.warn(`Error while cancelling consumer for channel ${c}: ${err?.message}`);
        });
      }
    }
  }

  /**
   * Re-establishes every known subscription. Called after a (re)connect.
   */
  protected async replaySubscriptions() {
    for (const descriptor of this.Subscriptions.values()) {
      await this.startConsumer(descriptor);
    }
  }

  /**
   * Declares the queue for a subscription and starts consuming, wiring ack/nack + retry/dead-letter.
   */
  protected async startConsumer(descriptor: ISubscriptionDescriptor) {
    const c = descriptor.channel;
    const queue = await this.assertSubscriptionQueue(c, descriptor.subscriptionId, descriptor.durable);
    descriptor.queue = queue;

    const { consumerTag } = await this.ConsumeChannel.consume(
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
          this.Log.error(`Cannot parse incoming message on channel ${c}, dead-lettering it: ${err?.message}`);
          this.deadLetterRaw(msg, this.Options.defaultQueueDeadLetterChannel, c, (err as Error)?.message ?? String(err));
          return;
        }

        descriptor
          .callback(qMessage)
          .then(() => this.ConsumeChannel.ack(msg))
          .catch((err) => this.handleFailedMessage(msg, qMessage, c, err));
      },
      { noAck: false },
    );

    descriptor.consumerTag = consumerTag;
    this.Log.success(`Channel ${c}, durable: ${descriptor.durable ? 'true' : 'false'} subscribed and ready to receive messages !`);
  }

  /**
   * Handles a message whose consumer callback rejected.
   *
   * Events are fire-and-forget - logged and acked ( dropped ). Jobs are retried up to their
   * RetryCount by re-publishing to a TTL "retry" queue that dead-letters back to the work queue
   * after an exponential delay, then dead-lettered once retries are exhausted.
   */
  protected handleFailedMessage(msg: ConsumeMessage, qMessage: IQueueMessage, channel: string, err: unknown) {
    const reason = (err as Error)?.message ?? String(err);

    // events are not retried or tracked - drop them
    if (qMessage.Type !== QueueMessageType.Job || this.isTopic(channel)) {
      this.Log.warn(`Handler failed on channel ${channel}, dropping message ${qMessage.Name}. ${reason}`);
      this.ConsumeChannel.ack(msg);
      return;
    }

    const maxRetries = (qMessage as IQueueJob).RetryCount ?? 0;
    const attempt = Number(msg.properties.headers?.[RETRY_COUNT_HEADER] ?? 0);

    if (attempt < maxRetries) {
      this.retryJob(msg, qMessage, channel, attempt + 1, reason).catch((retryErr) => {
        this.Log.error(`Failed to reschedule job ${qMessage.Name} on ${channel}, nacking instead: ${(retryErr as Error).message}`);
        this.ConsumeChannel.nack(msg, false, false);
      });
      return;
    }

    // retries exhausted - route to the dead-letter queue
    this.deadLetterRaw(msg, this.getDeadLetterChannelForMessage(qMessage), channel, reason, attempt);
  }

  /**
   * Republishes a failed job to a per-delay TTL retry queue that dead-letters back to the work
   * queue after the delay, giving broker-side ( crash-safe ) exponential backoff. Then acks original.
   */
  protected async retryJob(msg: ConsumeMessage, qMessage: IQueueMessage, workQueue: string, nextAttempt: number, reason: string) {
    const delay = this.retryBackoff(nextAttempt);
    const retryQueue = await this.assertRetryQueue(workQueue, delay);

    this.ConsumeChannel.sendToQueue(retryQueue, msg.content, {
      persistent: true,
      contentType: 'application/json',
      priority: msg.properties.priority,
      headers: { ...msg.properties.headers, [RETRY_COUNT_HEADER]: nextAttempt },
    });

    this.ConsumeChannel.ack(msg);
    this.Log.warn(`Job ${qMessage.Name} failed on ${workQueue}, retry ${nextAttempt}/${(qMessage as IQueueJob).RetryCount} scheduled in ${delay}ms. ${reason}`);
  }

  /**
   * Publishes a failed/unparseable message to the dead-letter queue and acks the original to
   * unblock the source queue. When no dead-letter queue is configured the message is dropped
   * ( acked ) with a warning - we never nack-loop a poison message forever.
   */
  protected deadLetterRaw(msg: ConsumeMessage, dlq: string | undefined, channel: string, reason: string, attempt?: number) {
    if (!dlq) {
      this.Log.warn(`Message failed on channel ${channel}, no dead-letter queue configured - dropping. ${reason}`);
      this.ConsumeChannel.ack(msg);
      return;
    }

    this.assertQueue(this.ConsumeChannel, dlq)
      .then(() => {
        this.ConsumeChannel.sendToQueue(dlq, msg.content, {
          persistent: true,
          contentType: 'application/json',
          headers: { ...msg.properties.headers, 'x-error': reason, ...(attempt !== undefined ? { [RETRY_COUNT_HEADER]: attempt } : {}) },
        });
        this.ConsumeChannel.ack(msg);
        this.Log.warn(`Message failed on channel ${channel}, routed to dead-letter ${dlq}. ${reason}`);
      })
      .catch((dlqErr) => {
        this.Log.error(`Failed to route message to dead-letter ${dlq}, nacking instead: ${(dlqErr as Error).message}`);
        this.ConsumeChannel.nack(msg, false, false);
      });
  }

  /**
   * Exponential backoff ( ms ) for the given retry attempt, based on `Options.retryDelay`.
   * Returns 0 ( immediate redelivery ) when no base delay is configured.
   */
  protected retryBackoff(attempt: number): number {
    const base = this.Options.retryDelay ?? 0;
    return base > 0 ? base * 2 ** (attempt - 1) : 0;
  }

  /**
   * Publisher-side resilience pipeline: bounds each publish by a timeout and retries transient
   * failures / nacks with exponential backoff. Consumer dedup ( by JobId ) makes the resulting
   * rare duplicates harmless.
   */
  protected buildEmitPipeline(): ResiliencePipeline<void> {
    const attempts = (this.Options.options?.emitRetries as number) ?? 3;
    const timeout = this.Options.receiptTimeout ?? 5000;
    const base = this.Options.retryDelay && this.Options.retryDelay > 0 ? this.Options.retryDelay : 200;

    return new ResiliencePipelineBuilder<void>()
      .addRetry({ MaxRetryAttempts: attempts, Delay: base, MaxDelay: 30000, BackoffType: BackoffType.Exponential, UseJitter: true })
      .addTimeout(timeout)
      .build();
  }

  protected async publishMessage(message: IQueueMessage): Promise<void> {
    const channels = this.getChannelForMessage(message);
    const buffer = Buffer.from(JSON.stringify(message));

    const publishOptions: Options.Publish = {
      persistent: !!message.Persistent,
      contentType: 'application/json',
    };

    if ((message as IQueueJob).JobId) {
      publishOptions.correlationId = (message as IQueueJob).JobId;
    }

    if (message.Priority) {
      publishOptions.priority = message.Priority;
    }

    for (const c of channels) {
      await this.EmitPipeline.execute(() => this.publishToChannel(c, buffer, publishOptions));
      this.Log.trace(`Published ${message.Type} Name: ${message.Name} to channel ${c} ( ${this.Options.name} )`);
    }
  }

  /** Asserts the destination ( once ) and publishes a single message on the confirm channel. */
  protected async publishToChannel(channel: string, buffer: Buffer, options: Options.Publish): Promise<void> {
    if (this.isTopic(channel)) {
      await this.assertExchange(this.PublishChannel, channel);
      await this.publishWithConfirm(channel, '', buffer, options);
    } else {
      await this.assertQueue(this.PublishChannel, channel);
      await this.publishWithConfirm('', channel, buffer, options);
    }
  }

  /**
   * Publishes on the confirm channel and resolves only once the broker acks the message.
   */
  protected publishWithConfirm(exchange: string, routingKey: string, content: Buffer, options: Options.Publish): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.PublishChannel.publish(exchange, routingKey, content, options, (err) => {
        if (err) {
          reject(err instanceof Error ? err : new UnexpectedServerError(`Broker nacked message on ${exchange || routingKey}`, err));
        } else {
          resolve();
        }
      });
    });
  }

  protected async flushPendingEmits() {
    if (this.PendingEmits.length === 0) {
      return;
    }

    const pending = this.PendingEmits;
    this.PendingEmits = [];

    this.Log.info(`Flushing ${pending.length} buffered message(s) for queue ${this.Options.name}`);

    for (const p of pending) {
      this.publishMessage(p.message).then(p.resolve).catch(p.reject);
    }
  }

  /**
   * Declares ( and for topics binds ) the broker queue a subscription should consume from.
   */
  protected async assertSubscriptionQueue(channel: string, subscriptionId?: string, durable?: boolean): Promise<string> {
    if (!this.isTopic(channel)) {
      return this.assertQueue(this.ConsumeChannel, channel);
    }

    await this.assertExchange(this.ConsumeChannel, channel);

    let queueName: string;

    if (durable) {
      if (!subscriptionId) {
        throw new InvalidArgument(`subscriptionId cannot be empty if using durable subscriptions`);
      }

      const q = await this.ConsumeChannel.assertQueue(subscriptionId, { durable: true, exclusive: false, autoDelete: false });
      queueName = q.queue;
    } else {
      // server-named, exclusive, auto-deleted queue ( unique per subscriber )
      const q = await this.ConsumeChannel.assertQueue(subscriptionId ?? '', { durable: false, exclusive: !subscriptionId, autoDelete: true });
      queueName = q.queue;
    }

    await this.ConsumeChannel.bindQueue(queueName, channel, '');

    return queueName;
  }

  /**
   * Declares a durable work queue, asserting it on the broker only once per connection.
   */
  protected async assertQueue(channel: Channel | ConfirmChannel, name: string): Promise<string> {
    if (!this.AssertedQueues.has(name)) {
      await channel.assertQueue(name, { durable: true });
      this.AssertedQueues.add(name);
    }

    return name;
  }

  /**
   * Declares a durable fanout exchange, asserting it on the broker only once per connection.
   */
  protected async assertExchange(channel: Channel | ConfirmChannel, name: string): Promise<void> {
    if (!this.AssertedExchanges.has(name)) {
      await channel.assertExchange(name, 'fanout', { durable: true });
      this.AssertedExchanges.add(name);
    }
  }

  /**
   * Declares a durable TTL retry queue that dead-letters expired messages back to `workQueue`
   * ( via the default exchange, routing key = queue name ). One queue per distinct delay.
   */
  protected async assertRetryQueue(workQueue: string, delay: number): Promise<string> {
    const name = `${workQueue}.retry.${delay}`;

    if (!this.AssertedRetryQueues.has(name)) {
      await this.ConsumeChannel.assertQueue(name, {
        durable: true,
        arguments: {
          'x-message-ttl': delay,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': workQueue,
        },
      });
      this.AssertedRetryQueues.add(name);
    }

    return name;
  }

  protected isTopic(channel: string): boolean {
    return channel.startsWith(this.TopicPrefix);
  }

  protected async closeChannel(channel?: Channel | ConfirmChannel) {
    try {
      if (channel) {
        await channel.close();
      }
    } catch (err) {
      this.Log.warn(`Error while closing AMQP channel for ${this.Options.name}: ${err?.message}`);
    }
  }

  protected warnOnUnsupportedScheduling(message: IQueueMessage) {
    if (message.ScheduleDelay || message.ScheduleCron || message.SchedulePeriod || message.ScheduleRepeat) {
      this.Log.warn(`Message ${message.Name} has scheduling options set, but the AMQP transport does not support delayed/scheduled delivery yet. Message will be delivered immediately.`);
    }
  }
}
