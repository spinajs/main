import { UnexpectedServerError, InvalidArgument } from '@spinajs/exceptions';
import { IQueueMessage, IQueueJob, IQueueConnectionOptions, IQueueCredentialsProvider, QueueClient, QueueHeaders, QueueMessage, QueueMessageType, UnparseableMessageError, decideDelivery, isCrash, isJob, readQueueHeaders, resolveDeliveryPolicy, retryCountOf, unparseableMessage, withoutTransportHeaders, type DeliveryDecision } from '@spinajs/queue';
import Stomp from '@stomp/stompjs';
import _ from 'lodash';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder } from '@spinajs/util';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';

/**
 * Renders a websocket error for the log. The event stompjs hands to `onWebSocketError`
 * comes straight from the socket implementation and can reference the underlying
 * TLSSocket / HTTPParser ( a circular graph ), so it must NEVER be JSON.stringified.
 * Prefer the real error ( `ws` wraps it in `ErrorEvent.error` ), then any message,
 * then the event type.
 */
export function describeWebSocketError(err: unknown): string {
  if (!err) {
    return 'unknown error';
  }

  const e = err as { error?: unknown; message?: unknown; type?: unknown; code?: unknown };
  const inner = e.error as { message?: unknown; code?: unknown } | undefined;

  const message = inner?.message ?? e.message;
  const code = inner?.code ?? e.code;

  if (typeof message === 'string' && message.length > 0) {
    // `ws` reports a socket that stompjs closed on `connectionTimeout` with this exact
    // message - the TCP / TLS / HTTP upgrade never completed, which is almost always
    // network ( security groups, routing, wrong port / scheme ) rather than the broker.
    if (message.includes('closed before the connection was established')) {
      return `${message} ( connection timeout - the websocket handshake never completed, check url / network path to the broker )`;
    }

    return code ? `${message} ( ${String(code)} )` : message;
  }

  if (typeof e.type === 'string') {
    return `event '${e.type}'`;
  }

  try {
    return String(err);
  } catch {
    return 'unserializable error';
  }
}

/**
 * Default time to wait for a broker RECEIPT frame when publishing a message
 * before the emit is considered failed. Can be overridden via `Options.receiptTimeout`.
 */
const DEFAULT_RECEIPT_TIMEOUT_MS = 5000;

/**
 * Time to wait for the initial STOMP connection before giving up.
 * Can be overridden via `Options.connectionTimeout`.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10000;

/**
 * Default reconnect / heartbeat timings used when not provided in connection options.
 *
 * NOTE on heartbeats: the default ( 4s ) suits brokers that support STOMP heartbeats over
 * WebSocket ( eg. ActiveMQ ). RabbitMQ Web-STOMP / SockJS does NOT support heartbeats - when
 * targeting it, set `heartbeatIncoming` and `heartbeatOutgoing` to 0 in the connection options,
 * otherwise the connection will be dropped. We keep 4s as the default so dead-connection
 * detection still works on brokers that do support it.
 */
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 4000;
const DEFAULT_PREFETCH = 1;
const TOPIC_PREFIX = '/topic/';
const VIRTUAL_TOPIC_PREFIX = '/topic/VirtualTopic.';

/** SEND frame headers stompjs or the broker own; stompjs spreads the frame headers over `destination`. */
const FRAME_HEADERS = new Set(['destination', 'receipt', 'transaction', 'content-length', 'content-type', 'message-id', 'subscription', 'ack']);

/**
 * Describes a subscription we want to keep alive across reconnects.
 *
 * stompjs does NOT replay subscriptions after a socket drop, so we track the
 * intent ( channel + callback + options ) and re-create the live subscription
 * inside `onConnect` on every ( re )connect.
 */
interface ISubscriptionDescriptor {
  channel: string;

  // runs every handler in `handlers`: one broker subscription per subscription key serves all of them,
  // because on a queue a second subscription would split the messages between the two
  callback: (e: IQueueMessage) => Promise<void>;

  // keyed by what was passed to subscribe(): the channel string or the message class
  handlers: Map<string | Constructor<QueueMessage>, (e: IQueueMessage) => Promise<void>>;
  subscriptionId?: string;
  durable?: boolean;
  // under virtual topics: the queue a named topic subscription consumes instead of the topic
  queue?: string;

  // current live subscription handle, valid only while connected
  active?: Stomp.StompSubscription;
}

/**
 * A message emitted while the client was disconnected. It is buffered and
 * flushed once the connection is ( re )established.
 */
interface IPendingEmit {
  message: IQueueMessage;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** The transport keys of the untyped `IQueueConnectionOptions.options` bag. */
interface IStompTransportOptions {
  clientIdSuffix?: string;
  receiptTimeout?: number;
  emitReconnectTimeout?: number;
  emitRetries?: number;
  prefetch?: unknown;
  virtualTopics?: unknown;
}

interface IReadyWaiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

const DEFAULT_EMIT_RECONNECT_TIMEOUT_MS = 60000;

@PerInstanceCheck()
@Injectable(QueueClient)
export class StompQueueClient extends QueueClient {
  protected Client: Stomp.Client;

  protected Subscriptions = new Map<string, ISubscriptionDescriptor>();

  protected PendingEmits: IPendingEmit[] = [];

  // settlers waiting for the connection to come up ( see whenReady ), rejected on dispose
  protected ReadyWaiters: IReadyWaiter[] = [];

  protected Disposing = false;
  protected PrefetchSize = DEFAULT_PREFETCH;
  protected VirtualTopics = false;

  /** Publisher-side resilience: retry each receipt-confirmed publish with backoff so a transient
   * broker hiccup / receipt timeout doesn't fail the emit. Duplicates are handled by consumer dedup. */
  protected EmitPipeline: ResiliencePipeline<void> = this.buildEmitPipeline();

  protected get TransportOptions(): IStompTransportOptions | undefined {
    return this.Options.options as IStompTransportOptions | undefined;
  }

  public get ClientId() {
    const base = this.Options.clientId ?? this.Options.name;
    // ActiveMQ refuses a second connection with the same client-id, so replicas need a stable per-instance suffix
    const suffix = this.TransportOptions?.clientIdSuffix || process.env.QUEUE_INSTANCE_ID;
    return suffix ? `${base}-${suffix}` : base;
  }

  /**
   * `true` when there is an active connection with the broker.
   */
  public get Connected(): boolean {
    return this.Client?.connected ?? false;
  }

  protected get ReceiptTimeout(): number {
    return this.Options.receiptTimeout ?? this.TransportOptions?.receiptTimeout ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  }

  protected get EmitReconnectTimeout(): number {
    return this.TransportOptions?.emitReconnectTimeout ?? DEFAULT_EMIT_RECONNECT_TIMEOUT_MS;
  }

  /**
   * Resolves once the client is connected. If already connected resolves immediately,
   * otherwise waits for the next ( re )connect, optionally bounded by `timeoutMs`.
   */
  public whenReady(timeoutMs?: number): Promise<void> {
    if (this.Connected) {
      return Promise.resolve();
    }

    if (this.Disposing) {
      return Promise.reject(new UnexpectedServerError(`Queue connection ${this.Options.name} is disposing`));
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const waiter: IReadyWaiter = {
        resolve: () => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve();
        },
        reject: (err) => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(err);
        },
      };

      if (timeoutMs) {
        timer = setTimeout(() => {
          this.ReadyWaiters = this.ReadyWaiters.filter((w) => w !== waiter);
          reject(new UnexpectedServerError(`Timeout waiting for queue connection ${this.Options.name} to become ready`));
        }, timeoutMs);
      }

      this.ReadyWaiters.push(waiter);
    });
  }

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  /**
   * Creates the underlying stompjs client. Extracted so it can be overridden
   * ( e.g. with a fake ) in unit tests without a live broker.
   */
  protected createClient(config: Stomp.StompConfig): Stomp.Client {
    return new Stomp.Client(config);
  }

  /**
   * Creates the raw websocket stompjs drives. One `ws` socket per ( re )connect attempt;
   * stompjs sets `binaryType`, the on* handlers and closes it itself.
   */
  protected createWebSocket(): Stomp.IStompSocket {
    if (!this.Options.host) {
      throw new InvalidArgument(`Queue connection ${this.Options.name} has no host configured`);
    }

    return new WebSocket(this.Options.host, Stomp.Versions.default.protocolVersions()) as unknown as Stomp.IStompSocket;
  }

  /** Reads `options.prefetch`; same key as queue-amqp-transport. */
  protected readPrefetch(): number {
    const raw = this.TransportOptions?.prefetch;
    if (raw === undefined) {
      return DEFAULT_PREFETCH;
    }

    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new InvalidArgument(`Queue connection ${this.Options.name}: options.prefetch must be a positive integer, got ${JSON.stringify(raw)}`);
    }

    return value;
  }

  protected readVirtualTopics(): boolean {
    const raw = this.TransportOptions?.virtualTopics;
    if (raw === undefined) {
      return false;
    }

    if (typeof raw !== 'boolean') {
      throw new InvalidArgument(`Queue connection ${this.Options.name}: options.virtualTopics must be a boolean, got ${JSON.stringify(raw)}`);
    }

    return raw;
  }

  public async resolve() {
    // createWebSocket() runs inside stompjs's un-awaited connect loop, where a throw would be
    // an unhandled rejection and leave this promise pending
    if (!this.Options.host) {
      throw new InvalidArgument(`Queue connection ${this.Options.name} has no host configured`);
    }

    this.PrefetchSize = this.readPrefetch();
    this.VirtualTopics = this.readVirtualTopics();

    this.Log.info({ host: this.Options.host, clientId: this.ClientId }, 'Connecting to STOMP queue at ${host} with client-id: ${clientId} ...');

    this.Client = this.createClient({
      brokerURL: this.Options.host,
      connectHeaders: {
        login: this.Options.login,
        passcode: this.Options.password,
        'client-id': this.ClientId,
      },
      reconnectDelay: this.Options.reconnectDelay ?? DEFAULT_RECONNECT_DELAY_MS,
      heartbeatIncoming: this.Options.heartbeatIncoming ?? DEFAULT_HEARTBEAT_MS,
      heartbeatOutgoing: this.Options.heartbeatOutgoing ?? DEFAULT_HEARTBEAT_MS,
      connectionTimeout: this.Options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS,

      // `ws` instead of the `websocket` package's W3C shim: the shim swallows the
      // connect-failure reason ( ECONNREFUSED / ETIMEDOUT / 401 / TLS ) and hands stompjs an
      // event whose `target` walks into the TLSSocket, so nothing about WHY a connection
      // failed ever reached the log. `ws` surfaces the real Error in `ErrorEvent.error`.
      webSocketFactory: () => this.createWebSocket(),

      // additional options ( may override any of the defaults above )
      ...this.Options.options,
    });

    // stompjs is chatty; keep it at trace unless the connection asks for debug output
    const debugLevel = this.Options.debug ? 'debug' : 'trace';
    this.Client.debug = (str: string) => {
      this.Log[debugLevel](`${str}, Client-id: ${this.ClientId}, name: ${this.Options.name}`);
    };

    // lifecycle handlers that simply log - installed once, never reassigned

    this.Client.onUnhandledMessage = (message) => {
      this.Log.warn({ destination: message.headers?.destination ?? '<unknown>', connection: this.Options.name, body: message.body }, 'Received unhandled message on ${destination} ( ${connection} ): ${body}');
    };

    this.Client.onDisconnect = () => {
      this.Log.warn({ clientId: this.ClientId }, 'Disconnected from STOMP client, client-id: ${clientId}');
    };

    this.Client.onWebSocketClose = (evt) => {
      // 1000 = clean close, 1006 = abnormal ( connect failed / dropped without a close frame ),
      // anything else usually comes from the broker with a reason
      this.Log.warn(
        { code: evt?.code ?? 'unknown', reason: evt?.reason, clientId: this.ClientId },
        'STOMP websocket closed ( code: ${code}${?reason}, reason: ${reason}${/reason} ), client-id: ${clientId} ( will auto-reconnect if active )',
      );
    };

    return new Promise<void>((resolve, reject) => {
      // ensures we settle the initial-connect promise exactly once, and that a
      // broker / websocket error only rejects BEFORE the first successful connect
      let settled = false;

      // if a credential provider is configured, refresh credentials right before
      // every ( re )connect - supports rotating secrets / token based auth
      if (this.Options.credentialProvider) {
        this.Client.beforeConnect = async () => {
          try {
            const provider = DI.resolve<IQueueCredentialsProvider>(this.Options.credentialProvider!);
            const creds = await provider.getCredentials(this.Options);

            this.Client.connectHeaders = {
              'client-id': this.ClientId,
              ...(creds.login ? { login: creds.login } : {}),
              ...(creds.passcode ? { passcode: creds.passcode } : {}),
            };
          } catch (err) {
            // stompjs does not await its connect loop: a throw here would be an unhandled rejection
            // with no socket close, so no reconnect would ever be scheduled
            if (!settled) {
              settled = true;
              void this.Client.deactivate();
              reject(new UnexpectedServerError(`Cannot get credentials for queue connection ${this.Options.name} from provider ${this.Options.credentialProvider}`, err));
              return;
            }

            // reconnect with the last credentials: a broker refusal closes the socket and stompjs retries
            this.Log.error({ error: err, provider: this.Options.credentialProvider, clientId: this.ClientId }, 'Credential provider ${provider} failed, reconnecting with previous credentials, client-id: ${clientId}');
          }
        };
      }

      // onConnect fires on EVERY ( re )connect - this is where we replay
      // subscriptions and flush buffered emits so the client survives drops
      this.Client.onConnect = () => {
        this.Log.success({ clientId: this.ClientId }, 'Connected to STOMP client, client-id: ${clientId}');

        for (const desc of this.Subscriptions.values()) {
          this.applySubscription(desc);
        }

        this.flushPendingEmits();
        this.flushReadyWaiters();

        if (!settled) {
          settled = true;
          resolve();
        }
      };

      this.Client.onStompError = (frame) => {
        // Compliant brokers terminate the connection after an ERROR frame.
        // Bad login / passcode typically surfaces here.
        const brokerMessage = frame.headers['message'] ?? '';
        this.Log.error({ brokerMessage }, 'Broker reported error: ${brokerMessage}');
        this.Log.error({ details: frame.body }, 'Additional details: ${details}');

        if (!settled) {
          settled = true;
          const hint = /already connected|InvalidClientID/i.test(brokerMessage) ? ` - client-id ${this.ClientId} is in use by another connection; give every replica a stable, unique QUEUE_INSTANCE_ID ( or options.clientIdSuffix )` : '';
          this.Client.deactivate();
          reject(new UnexpectedServerError(`Cannot connect to queue server at ${this.Options.host}: ${brokerMessage}${hint}`, frame));
        }
      };

      this.Client.onWebSocketError = (err) => {
        // Settle FIRST. This handler runs inside the socket's event dispatch - anything
        // thrown here ( a bad log call, a serializer choking on the event ) becomes an
        // uncaughtException and, worse, would leave the initial-connect promise pending
        // forever, hanging whoever awaits resolve() ( QueueService boot ).
        const reason = describeWebSocketError(err);

        if (!settled) {
          settled = true;
          void this.Client.deactivate();
          reject(new UnexpectedServerError(`Cannot connect to queue server at ${this.Options.host}, websocket error: ${reason}`, err));
        }

        try {
          this.Log.error({ reason, clientId: this.ClientId }, 'Websocket error: ${reason}, client-id: ${clientId}');
        } catch {
          // logging must never take the connection down
        }
      };

      this.Client.activate();
    });
  }

  public async dispose() {
    this.Log.info({ connection: this.Options.name }, 'Disposing queue connection ${connection} ...');

    this.Disposing = true;

    // fail any still-buffered emits so callers awaiting them don't hang forever
    const pending = this.PendingEmits;
    this.PendingEmits = [];
    for (const p of pending) {
      p.reject(new UnexpectedServerError(`Queue connection ${this.Options.name} disposed before message could be sent`));
    }

    const waiters = this.ReadyWaiters;
    this.ReadyWaiters = [];
    for (const w of waiters) {
      w.reject(new UnexpectedServerError(`Queue connection ${this.Options.name} disposed before it became ready`));
    }

    // the live subscriptions end with the socket; deactivate() sends no UNSUBSCRIBE, so durable ones stay on the broker
    this.Subscriptions.clear();

    if (!this.Client) {
      return;
    }

    // deactivate() resolves once the underlying websocket is disposed
    await this.Client.deactivate();

    this.Log.success('STOMP client deactivated');
  }

  public async emit(message: IQueueMessage): Promise<void> {
    if (!this.Client?.connected) {
      if (this.Disposing) {
        throw new UnexpectedServerError(`Cannot emit message, queue connection ${this.Options.name} is disposing`);
      }

      // not connected - buffer and flush on next ( re )connect
      return new Promise<void>((resolve, reject) => {
        this.PendingEmits.push({ message, resolve, reject });
        this.Log.warn({ connection: this.Options.name, messageName: message.Name, pending: this.PendingEmits.length }, 'Queue ${connection} not connected, message ${messageName} buffered ( ${pending} pending )');
      });
    }

    return this.publishMessage(message);
  }

  public unsubscribe(channelOrMessage: string | Constructor<QueueMessage>, removeDurable = false) {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    for (const [key, desc] of [...this.Subscriptions]) {
      if (!channels.includes(desc.channel)) {
        continue;
      }

      // a string drops the whole channel, a message class only its own handler
      if (_.isString(channelOrMessage)) {
        desc.handlers.clear();
      } else {
        desc.handlers.delete(channelOrMessage);
      }

      if (desc.handlers.size > 0) {
        continue;
      }

      this.endSubscription(desc, removeDurable);
      this.Subscriptions.delete(key);
    }
  }

  /** Ends the live subscription of a descriptor nobody handles any more. */
  protected endSubscription(desc: ISubscriptionDescriptor, removeDurable: boolean) {
    const frameId = this.frameIdOf(desc);

    if (!this.Connected) {
      // the live subscription went away with the socket; UNSUBSCRIBE cannot be sent without one
      if (desc.durable && removeDurable) {
        this.Log.warn({ subscriptionId: desc.subscriptionId, channel: desc.channel }, 'Not connected, broker-side durable subscription ${subscriptionId} on channel ${channel} was not removed');
      }
    } else if (!desc.queue && desc.durable && removeDurable && desc.subscriptionId && frameId) {
      // delete the broker-side durable subscription, not just stop consuming.
      // ActiveMQ removes a durable sub when UNSUBSCRIBE carries its subscription name.
      this.Client.unsubscribe(frameId, { 'activemq.subscriptionName': desc.subscriptionId });
      this.Log.info({ subscriptionId: desc.subscriptionId, channel: desc.channel }, 'Removed durable subscription ${subscriptionId} on channel ${channel}');
    } else {
      if (desc.queue && removeDurable) {
        this.Log.warn({ queue: desc.queue, channel: desc.channel }, 'Stopped consuming ${queue}; the consumer queue of ${channel} stays on the broker and keeps collecting messages until it is deleted there');
      }
      desc.active?.unsubscribe();
    }
  }

  /** Topic subscriptions with different subscription ids are separate broker subscriptions; everything else shares the channel's. */
  protected subscriptionKey(channel: string, subscriptionId?: string): string {
    return channel.startsWith(TOPIC_PREFIX) && subscriptionId ? `${channel}#${subscriptionId}` : channel;
  }

  /** stompjs routes a MESSAGE frame by the SUBSCRIBE id, so two subscriptions of one connection never share one. */
  protected frameIdOf(desc: ISubscriptionDescriptor): string | undefined {
    return desc.subscriptionId ? `${desc.subscriptionId}@${desc.channel}` : undefined;
  }

  /** ActiveMQ's virtual-topic convention: a named subscriber of VirtualTopic.X consumes the queue Consumer.<id>.VirtualTopic.X. */
  protected consumerQueueOf(channel: string, subscriptionId?: string): string | undefined {
    if (!this.VirtualTopics || !subscriptionId || !channel.startsWith(VIRTUAL_TOPIC_PREFIX)) {
      return undefined;
    }

    return `/queue/Consumer.${subscriptionId}.VirtualTopic.${channel.slice(VIRTUAL_TOPIC_PREFIX.length)}`;
  }

  /** Refuses, when the subscription is made, what the failure path could not execute later. */
  protected assertSubscribable(channelOrMessage: string | Constructor<QueueMessage>, channels: string[], subscriptionId?: string): void {
    const topics = channels.filter((c) => c.startsWith(TOPIC_PREFIX));

    if (this.VirtualTopics && subscriptionId && topics.length > 0) {
      if (/[.*>]/.test(subscriptionId)) {
        throw new InvalidArgument(`subscriptionId ${subscriptionId} names an ActiveMQ consumer queue under options.virtualTopics, so it cannot contain '.', '*' or '>'`);
      }

      const plain = topics.filter((c) => !c.startsWith(VIRTUAL_TOPIC_PREFIX));
      if (plain.length > 0) {
        throw new InvalidArgument(`With options.virtualTopics a named topic subscription consumes a queue, which only a /topic/VirtualTopic.* channel has; ${plain.join(', ')} is not one ( connection ${this.Options.name} )`);
      }
    }

    if (!_.isString(channelOrMessage) && this.getRouteOption(channelOrMessage, 'onEventFailure') === 'retry') {
      const stranded = topics.filter((c) => !this.consumerQueueOf(c, subscriptionId));
      if (stranded.length > 0) {
        throw new InvalidArgument(
          `queue.routing.${channelOrMessage.name}.onEventFailure is 'retry', but ${stranded.join(', ')} on connection ${this.Options.name} has no consumer queue to retry into: set options.virtualTopics, give the subscription a subscriptionId and route the event to a /topic/VirtualTopic.* channel, or route it to a /queue/ channel`,
        );
      }
    }
  }

  public async subscribe(channelOrMessage: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void> {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);
    this.assertSubscribable(channelOrMessage, channels, subscriptionId);

    channels.forEach((c) => {
      const key = this.subscriptionKey(c, subscriptionId);
      const existing = this.Subscriptions.get(key);

      if (existing?.handlers.has(channelOrMessage)) {
        this.Log.warn({ channel: c }, 'Channel ${channel} already subscribed !');
        return;
      }

      if (durable && !subscriptionId) {
        throw new InvalidArgument(`subscriptionId cannot be empty if using durable subscriptions`);
      }

      if (existing) {
        existing.handlers.set(channelOrMessage, callback);
        this.Log.info({ channel: c }, 'Channel ${channel} already subscribed, handler added to the existing subscription');
        return;
      }

      const handlers: ISubscriptionDescriptor['handlers'] = new Map([[channelOrMessage, callback]]);
      const desc: ISubscriptionDescriptor = {
        channel: c,
        callback: (e) => Promise.all([...handlers.values()].map((h) => h(e))).then(() => undefined),
        handlers,
        subscriptionId,
        durable,
        queue: this.consumerQueueOf(c, subscriptionId),
      };
      this.Subscriptions.set(key, desc);

      // if already connected subscribe now, otherwise it will be applied on next onConnect
      if (this.Client?.connected) {
        this.applySubscription(desc);
      } else {
        this.Log.info({ channel: c }, 'Channel ${channel} recorded, will subscribe once connected');
      }
    });
  }

  /**
   * Creates the live broker subscription for a tracked descriptor.
   * Called on initial subscribe and replayed for every descriptor on reconnect.
   */
  protected applySubscription(desc: ISubscriptionDescriptor) {
    const headers: Stomp.StompHeaders = { ack: 'client-individual', 'activemq.prefetchSize': `${this.PrefetchSize}` };

    const frameId = this.frameIdOf(desc);
    if (frameId) {
      headers.id = frameId;
    }

    // a consumer queue is durable by nature and takes no subscription name
    if (desc.durable && !desc.queue) {
      // durable subscriptions require a stable name ( guarded in subscribe() )
      headers['activemq.subscriptionName'] = desc.subscriptionId!;
    }

    desc.active = this.Client.subscribe(
      desc.queue ?? desc.channel,
      (message) => {
        let qMessage: IQueueMessage;

        try {
          qMessage = JSON.parse(message.body);
        } catch (err) {
          this.Log.error({ error: err, channel: desc.channel }, 'Cannot parse message body on channel ${channel}');
          this.handleUnparseableMessage(message, desc, err);
          return;
        }

        // luxon DateTime serializes to an ISO string over the wire - rehydrate it
        if (typeof (qMessage.CreatedAt as unknown) === 'string') {
          qMessage.CreatedAt = DateTime.fromISO(qMessage.CreatedAt as unknown as string);
        }

        this.fromFrame(qMessage, message);

        // two-argument then: a failed settle must not be treated as a failed handler
        // eslint-disable-next-line promise/catch-or-return -- both handlers settle the message and log their own errors, there is nothing left to catch
        desc.callback(qMessage).then(
          () => this.settle(message, 'ack'),
          (err) => this.handleFailedMessage(message, qMessage, desc, err),
        );
      },
      headers,
    );

    this.Log.success({ channel: desc.channel, durable: !!desc.durable }, 'Channel ${channel}, durable: ${durable} subscribed and ready to receive messages !');
  }

  /**
   * STOMP's own `message-id` is the broker's id, so the MessageId travels in `x-spinajs-message-id`. The body wins for
   * MessageId; the frame's standard headers win over the body's, since retries and dead letters rewrite them.
   */
  protected fromFrame(qMessage: IQueueMessage, message: Stomp.IMessage): void {
    const messageId = qMessage.MessageId ?? message.headers?.[QueueHeaders.MessageId];
    const standard = readQueueHeaders(message.headers);
    if (messageId !== undefined) qMessage.MessageId = messageId;
    if (qMessage.Headers || Object.keys(standard).length > 0) qMessage.Headers = { ...qMessage.Headers, ...standard };
  }

  /** A crash stands for a dead consumer: nothing is settled, and the broker redelivers when the connection drops. */
  protected handleFailedMessage(message: Stomp.IMessage, qMessage: IQueueMessage, desc: ISubscriptionDescriptor, err: unknown) {
    if (isCrash(err)) {
      this.Log.error({ error: err, channel: desc.channel, messageName: qMessage.Name }, 'The consumer of ${messageName} on ${channel} crashed; the frame stays unsettled until the connection drops');
      return;
    }

    const decision = decideDelivery(qMessage, retryCountOf(message.headers), err, resolveDeliveryPolicy(this, qMessage));
    this.executeDecision(message, qMessage, desc, decision);
  }

  protected executeDecision(message: Stomp.IMessage, qMessage: IQueueMessage, desc: ISubscriptionDescriptor, decision: DeliveryDecision) {
    if (decision.action === 'ack') {
      if (decision.dropped) {
        this.Log.warn({ channel: desc.channel, messageName: qMessage.Name, reason: decision.reason }, 'Event handler failed on channel ${channel}, dropping message ${messageName}. ${reason}');
      }
      this.settle(message, 'ack');
      return;
    }

    if (decision.action === 'dead-letter') {
      this.deadLetter(message, decision.channel, { ...decision.headers, [QueueHeaders.OriginalDestination]: desc.channel });
      return;
    }

    // a republish to a topic reaches every subscriber, so without a consumer queue a topic takes back a job only
    const target = desc.queue ?? (!desc.channel.startsWith(TOPIC_PREFIX) || qMessage.Type === QueueMessageType.Job ? desc.channel : undefined);
    if (!target) {
      if (decision.forced) {
        // never acked; a NACK does not redeliver on ActiveMQ, the frame goes to the broker's dead-letter queue
        this.Log.error({ channel: desc.channel, messageName: qMessage.Name }, '${messageName} on ${channel} asked for a later delivery, but this topic subscription has no consumer queue to redeliver into; nacking it');
        this.settle(message, 'nack');
        return;
      }

      this.Log.error({ channel: desc.channel, messageName: qMessage.Name }, 'Event ${messageName} on ${channel} cannot be retried without options.virtualTopics and a subscriptionId; dropping it');
      this.settle(message, 'ack');
      return;
    }

    // AMQ_SCHEDULED_* of the original are not copied: the delay below replaces them, and a cron must not run again on a retry
    const headers: Stomp.StompHeaders = { persistent: 'true', 'content-type': 'application/json', ...decision.headers };
    if (qMessage.Priority) {
      headers.priority = `${qMessage.Priority}`;
    }
    if (isJob(qMessage) && qMessage.JobId) {
      headers['correlation-id'] = qMessage.JobId;
    }
    if (decision.delayMs > 0) {
      headers.AMQ_SCHEDULED_DELAY = `${decision.delayMs}`;
    }

    // ack the original only once the broker confirmed the rescheduled copy
    this.sendWithReceipt(target, message.body, headers)
      .then(() => {
        this.settle(message, 'ack');
        this.Log.warn({ messageName: qMessage.Name, channel: target, attempt: decision.attempt, delay: decision.delayMs, reason: decision.headers[QueueHeaders.Error] }, '${messageName} failed on ${channel}, retry ${attempt} scheduled in ${delay}ms. ${reason}');
      })
      .catch((retryErr) => {
        this.Log.error({ error: retryErr, messageName: qMessage.Name, channel: target }, 'Failed to reschedule ${messageName} on ${channel}, nacking instead');
        this.settle(message, 'nack');
      });
  }

  /** A body that is not JSON has no type and no route: it goes to the connection's dead-letter channel. */
  protected handleUnparseableMessage(message: Stomp.IMessage, desc: ISubscriptionDescriptor, err: unknown) {
    const stand = unparseableMessage();
    const frameId = message.headers?.[QueueHeaders.MessageId];
    const decision = decideDelivery(frameId ? { ...stand, MessageId: frameId } : stand, 0, new UnparseableMessageError(err), resolveDeliveryPolicy(this, stand));
    this.executeDecision(message, stand, desc, decision);
  }

  /**
   * Publishes the message to the dead-letter channel and acks the original once the broker confirmed. Without a
   * dead-letter channel the message is dropped ( acked ) with a warning: a poison message is never nack-looped.
   */
  protected deadLetter(message: Stomp.IMessage, dlq: string | undefined, headers: Record<string, string>) {
    const channel = headers[QueueHeaders.OriginalDestination];
    const reason = headers[QueueHeaders.Error];

    if (!dlq) {
      this.Log.warn({ channel, reason }, 'Message failed on channel ${channel} and no dead-letter channel is configured - dropping. ${reason}');
      this.settle(message, 'ack');
      return;
    }

    this.sendWithReceipt(dlq, message.body, { persistent: 'true', 'content-type': 'application/json', ...headers })
      .then(() => {
        this.settle(message, 'ack');
        this.Log.warn({ channel, deadLetterChannel: dlq, reason }, 'Message failed on channel ${channel}, routed to dead-letter ${deadLetterChannel}. ${reason}');
      })
      .catch((dlqErr) => {
        this.Log.error({ error: dlqErr, deadLetterChannel: dlq }, 'Failed to route message to dead-letter ${deadLetterChannel}, nacking instead');
        this.settle(message, 'nack');
      });
  }

  /** Only a consumer queue can take a later delivery; a NACK goes to the broker's dead-letter queue. */
  public get RedeliversFailedEvents(): boolean {
    return this.VirtualTopics;
  }

  /**
   * stompjs throws from ack() / nack() once the socket is gone. The broker redelivers an unsettled
   * message after the reconnect anyway, so a failed settle is logged instead of escaping as an
   * unhandled rejection.
   */
  protected settle(message: Stomp.IMessage, how: 'ack' | 'nack') {
    try {
      if (how === 'ack') {
        message.ack();
      } else {
        message.nack();
      }
    } catch (err) {
      this.Log.warn(
        { error: err, how, destination: message.headers?.destination ?? '<unknown>', connection: this.Options.name },
        'Cannot ${how} message on ${destination} ( ${connection} ), the broker will redeliver it',
      );
    }
  }

  /**
   * Publisher-side resilience pipeline used by emit(). Retries a failed / timed-out receipt
   * publish with exponential backoff ( the per-attempt timeout lives in publishWithReceipt ).
   */
  protected buildEmitPipeline(): ResiliencePipeline<void> {
    const attempts = this.TransportOptions?.emitRetries ?? 3;
    const base = this.Options.retryDelay && this.Options.retryDelay > 0 ? this.Options.retryDelay : 200;

    return new ResiliencePipelineBuilder<void>().addRetry({ MaxRetryAttempts: attempts, Delay: base, MaxDelay: 30000, BackoffType: BackoffType.Exponential, UseJitter: true }).build();
  }

  /**
   * Publishes a message to all of its routed channels and resolves only once the
   * broker has acknowledged each publish with a RECEIPT frame.
   */
  protected publishMessage(message: IQueueMessage): Promise<void> {
    const channels = this.getChannelForMessage(message);
    // application headers first, so every header set below wins over them
    const headers: Stomp.StompHeaders = { ..._.omitBy(withoutTransportHeaders(message.Headers), (_value, name) => FRAME_HEADERS.has(name.toLowerCase())), 'content-type': 'application/json' };

    if (message.MessageId) {
      headers[QueueHeaders.MessageId] = message.MessageId;
    }

    // tie jobs to their JobModel row for broker-side traceability
    if ((message as IQueueJob).JobId) {
      headers['correlation-id'] = (message as IQueueJob).JobId!;
    }

    if (message.Persistent) {
      headers['persistent'] = 'true';
    }

    if (message.Priority) {
      headers.priority = `${message.Priority}`;
    }

    if (message.ScheduleCron) {
      headers['AMQ_SCHEDULED_CRON'] = message.ScheduleCron;
    }

    if (message.ScheduleDelay) {
      headers['AMQ_SCHEDULED_DELAY'] = message.ScheduleDelay.toString();
    }

    if (message.SchedulePeriod) {
      headers['AMQ_SCHEDULED_PERIOD'] = message.SchedulePeriod.toString();
    }

    if (message.ScheduleRepeat) {
      headers['AMQ_SCHEDULED_REPEAT'] = message.ScheduleRepeat.toString();
    }

    const body = JSON.stringify(message);

    return Promise.all(channels.map((c) => this.EmitPipeline.execute(() => this.publishWhenConnected(c, body, headers, message)))).then(() => undefined);
  }

  /**
   * A retry that runs after the socket dropped would otherwise hit stompjs' torn-down handler and fail the
   * emit in milliseconds, long before the broker is back.
   */
  protected publishWhenConnected(channel: string, body: string, headers: Stomp.StompHeaders, message: IQueueMessage): Promise<void> {
    if (this.Disposing) {
      return Promise.reject(new UnexpectedServerError(`Queue connection ${this.Options.name} is disposing`));
    }

    if (this.Client?.connected) {
      return this.publishWithReceipt(channel, body, headers, message);
    }

    return this.whenReady(this.EmitReconnectTimeout).then(() => this.publishWithReceipt(channel, body, headers, message));
  }

  /**
   * Publishes to a single channel and waits for the broker RECEIPT frame so the
   * caller gets real delivery confirmation ( bounded by `ReceiptTimeout` ).
   */
  protected publishWithReceipt(channel: string, body: string, headers: Stomp.StompHeaders, message: IQueueMessage): Promise<void> {
    return this.sendWithReceipt(channel, body, headers).then(() => {
      this.Log.trace({ messageType: message.Type, messageName: message.Name, channel, connection: this.Options.name }, 'Published ${messageType} Name: ${messageName} to channel ${channel} ( ${connection} )');
    });
  }

  /**
   * Sends one frame and resolves on its broker RECEIPT, or rejects after `ReceiptTimeout`
   * or when the publish throws.
   */
  protected sendWithReceipt(channel: string, body: string, headers: Stomp.StompHeaders): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const receiptId = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;

      this.Client.watchForReceipt(receiptId, () => {
        clearTimeout(timer);
        resolve();
      });

      timer = setTimeout(() => {
        // stompjs has no public API to drop a receipt watcher; without this it lives as long as the socket
        delete (this.Client as unknown as { _stompHandler?: { _receiptWatchers?: Record<string, unknown> } })._stompHandler?._receiptWatchers?.[receiptId];
        reject(new UnexpectedServerError(`Timeout waiting for broker receipt while publishing to ${channel} ( ${this.Options.name} )`));
      }, this.ReceiptTimeout);

      try {
        this.Client.publish({
          destination: channel,
          body,
          headers: { ...headers, receipt: receiptId },
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Flushes messages buffered while disconnected. Called from `onConnect`.
   */
  protected flushPendingEmits() {
    if (this.PendingEmits.length === 0) {
      return;
    }

    const pending = this.PendingEmits;
    this.PendingEmits = [];

    this.Log.info({ count: pending.length, connection: this.Options.name }, 'Flushing ${count} buffered message(s) for queue ${connection}');

    for (const p of pending) {
      this.publishMessage(p.message).then(p.resolve).catch(p.reject);
    }
  }

  /**
   * Resolves everyone waiting on {@link whenReady}. Called from `onConnect`.
   */
  protected flushReadyWaiters() {
    if (this.ReadyWaiters.length === 0) {
      return;
    }

    const waiters = this.ReadyWaiters;
    this.ReadyWaiters = [];

    for (const w of waiters) {
      w.resolve();
    }
  }
}
