import { UnexpectedServerError, InvalidArgument } from '@spinajs/exceptions';
import { IQueueMessage, IQueueConnectionOptions, QueueClient, QueueMessage } from '@spinajs/queue';
import Stomp from '@stomp/stompjs';
import _ from 'lodash';
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';
import websocket from 'websocket';
import { randomUUID } from 'crypto';

Object.assign(global, { WebSocket: websocket.w3cwebsocket });

/**
 * Default time to wait for a broker RECEIPT frame when publishing a message
 * before the emit is considered failed. Can be overridden via `Options.options.receiptTimeout`.
 */
const DEFAULT_RECEIPT_TIMEOUT_MS = 5000;

/**
 * Time to wait for the initial STOMP connection before giving up.
 * Can be overridden via `Options.options.connectionTimeout`.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10000;

/**
 * Describes a subscription we want to keep alive across reconnects.
 *
 * stompjs does NOT replay subscriptions after a socket drop, so we track the
 * intent ( channel + callback + options ) and re-create the live subscription
 * inside `onConnect` on every ( re )connect.
 */
interface ISubscriptionDescriptor {
  channel: string;
  callback: (e: IQueueMessage) => Promise<void>;
  subscriptionId?: string;
  durable?: boolean;

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

@PerInstanceCheck()
@Injectable(QueueClient)
export class StompQueueClient extends QueueClient {
  protected Client: Stomp.Client;

  protected Subscriptions = new Map<string, ISubscriptionDescriptor>();

  protected PendingEmits: IPendingEmit[] = [];

  protected Disposing = false;

  public get ClientId() {
    return this.Options.clientId ?? this.Options.name;
  }

  protected get ReceiptTimeout(): number {
    return this.Options.options?.receiptTimeout ?? DEFAULT_RECEIPT_TIMEOUT_MS;
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

  public async resolve() {
    this.Log.info(`Connecting to STOMP queue at ${this.Options.host} with client-id: ${this.ClientId} ...`);

    this.Client = this.createClient({
      brokerURL: this.Options.host,
      connectHeaders: {
        login: this.Options.login,
        passcode: this.Options.password,
        'client-id': this.ClientId,
      },
      reconnectDelay: 5000,
      heartbeatIncoming: 4000,
      heartbeatOutgoing: 4000,
      connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,

      // additional options ( may override any of the defaults above )
      ...this.Options.options,
    });

    this.Client.debug = (str: string) => {
      this.Log.trace(`${str}, Client-id: ${this.ClientId}, name: ${this.Options.name}`);
    };

    // lifecycle handlers that simply log - installed once, never reassigned

    this.Client.onDisconnect = () => {
      this.Log.warn(`Disconnected from STOMP client, client-id: ${this.ClientId}`);
    };

    this.Client.onWebSocketClose = () => {
      this.Log.warn(`STOMP websocket closed, client-id: ${this.ClientId} ( will auto-reconnect if active )`);
    };

    return new Promise<void>((resolve, reject) => {
      // ensures we settle the initial-connect promise exactly once, and that a
      // broker / websocket error only rejects BEFORE the first successful connect
      let settled = false;

      // onConnect fires on EVERY ( re )connect - this is where we replay
      // subscriptions and flush buffered emits so the client survives drops
      this.Client.onConnect = () => {
        this.Log.success('Connected to STOMP client, client-id: ' + this.ClientId);

        for (const desc of this.Subscriptions.values()) {
          this.applySubscription(desc);
        }

        this.flushPendingEmits();

        if (!settled) {
          settled = true;
          resolve();
        }
      };

      this.Client.onStompError = (frame) => {
        // Compliant brokers terminate the connection after an ERROR frame.
        // Bad login / passcode typically surfaces here.
        this.Log.error('Broker reported error: ' + frame.headers['message']);
        this.Log.error('Additional details: ' + frame.body);

        if (!settled) {
          settled = true;
          this.Client.deactivate();
          reject(new UnexpectedServerError(`Cannot connect to queue server at ${this.Options.host}`, frame));
        }
      };

      this.Client.onWebSocketError = (err) => {
        this.Log.error(`Websocket error: ${JSON.stringify(err)}, client-id: ${this.ClientId}`);

        if (!settled) {
          settled = true;
          this.Client.deactivate();
          reject(new UnexpectedServerError(`Cannot connect to queue server at ${this.Options.host}, websocket error`, err));
        }
      };

      this.Client.activate();
    });
  }

  public async dispose() {
    this.Log.info(`Disposing queue connection ${this.Options.name} ...`);

    this.Disposing = true;

    // fail any still-buffered emits so callers awaiting them don't hang forever
    const pending = this.PendingEmits;
    this.PendingEmits = [];
    for (const p of pending) {
      p.reject(new UnexpectedServerError(`Queue connection ${this.Options.name} disposed before message could be sent`));
    }

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
        this.Log.warn(`Queue ${this.Options.name} not connected, message ${message.Name} buffered ( ${this.PendingEmits.length} pending )`);
      });
    }

    return this.publishMessage(message);
  }

  public unsubscribe(channelOrMessage: string | Constructor<QueueMessage>) {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    channels.forEach((c) => {
      const desc = this.Subscriptions.get(c);

      if (!desc) {
        return;
      }

      desc.active?.unsubscribe();
      this.Subscriptions.delete(c);
    });
  }

  public async subscribe(channelOrMessage: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void> {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    channels.forEach((c) => {
      if (this.Subscriptions.has(c)) {
        this.Log.warn(`Channel ${c} already subscribed !`);
        return;
      }

      if (durable && !subscriptionId) {
        throw new InvalidArgument(`subscriptionId cannot be empty if using durable subscriptions`);
      }

      const desc: ISubscriptionDescriptor = { channel: c, callback, subscriptionId, durable };
      this.Subscriptions.set(c, desc);

      // if already connected subscribe now, otherwise it will be applied on next onConnect
      if (this.Client?.connected) {
        this.applySubscription(desc);
      } else {
        this.Log.info(`Channel ${c} recorded, will subscribe once connected`);
      }
    });
  }

  /**
   * Creates the live broker subscription for a tracked descriptor.
   * Called on initial subscribe and replayed for every descriptor on reconnect.
   */
  protected applySubscription(desc: ISubscriptionDescriptor) {
    const headers: Stomp.StompHeaders = { ack: 'client-individual', 'activemq.prefetchSize': '1' };

    if (desc.subscriptionId) {
      headers.id = desc.subscriptionId;
    }

    if (desc.durable) {
      // durable subscriptions require a stable name ( guarded in subscribe() )
      headers['activemq.subscriptionName'] = desc.subscriptionId!;
    }

    desc.active = this.Client.subscribe(
      desc.channel,
      (message) => {
        let qMessage: IQueueMessage;

        try {
          qMessage = JSON.parse(message.body);
        } catch (err) {
          this.Log.error(`Cannot parse message body on channel ${desc.channel}: ${(err as Error).message}`);
          this.handleFailedMessage(message, desc.channel, err);
          return;
        }

        desc
          .callback(qMessage)
          .then(() => {
            message.ack();
          })
          .catch((err) => {
            this.handleFailedMessage(message, desc.channel, err);
          });
      },
      headers,
    );

    this.Log.success(`Channel ${desc.channel}, durable: ${desc.durable ? 'true' : 'false'} subscribed and ready to receive messages !`);
  }

  /**
   * Handles a message whose consumer callback rejected ( or whose body could not be parsed ).
   *
   * If a dead-letter channel is configured the message is forwarded there and the
   * original is acked to unblock the source queue. Otherwise we nack and let the
   * broker apply its own redelivery / DLQ policy.
   */
  protected handleFailedMessage(message: Stomp.IMessage, channel: string, err: unknown) {
    const dlq = this.Options.defaultQueueDeadLetterChannel;
    const reason = (err as Error)?.message ?? String(err);

    if (!dlq) {
      this.Log.warn(`Message handler failed on channel ${channel}, no dead-letter channel configured - nacking. ${reason}`);
      message.nack();
      return;
    }

    try {
      this.Client.publish({
        destination: dlq,
        body: message.body,
        headers: {
          persistent: 'true',
          'x-original-destination': channel,
          'x-error': reason,
        },
      });

      message.ack();

      this.Log.warn(`Message handler failed on channel ${channel}, routed to dead-letter ${dlq}. ${reason}`);
    } catch (dlqErr) {
      this.Log.error(`Failed to route message to dead-letter ${dlq}, nacking instead: ${(dlqErr as Error).message}`);
      message.nack();
    }
  }

  /**
   * Publishes a message to all of its routed channels and resolves only once the
   * broker has acknowledged each publish with a RECEIPT frame.
   */
  protected publishMessage(message: IQueueMessage): Promise<void> {
    const channels = this.getChannelForMessage(message);
    const headers: Stomp.StompHeaders = {};

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

    return Promise.all(channels.map((c) => this.publishWithReceipt(c, body, headers, message))).then(() => undefined);
  }

  /**
   * Publishes to a single channel and waits for the broker RECEIPT frame so the
   * caller gets real delivery confirmation ( bounded by `ReceiptTimeout` ).
   */
  protected publishWithReceipt(channel: string, body: string, headers: Stomp.StompHeaders, message: IQueueMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const receiptId = randomUUID();
      let timer: ReturnType<typeof setTimeout>;

      this.Client.watchForReceipt(receiptId, () => {
        clearTimeout(timer);
        this.Log.trace(`Published ${message.Type} Name: ${message.Name} to channel ${channel} ( ${this.Options.name} )`);
        resolve();
      });

      timer = setTimeout(() => {
        reject(new UnexpectedServerError(`Timeout waiting for broker receipt while publishing to ${channel} ( ${this.Options.name} )`));
      }, this.ReceiptTimeout);

      this.Client.publish({
        destination: channel,
        body,
        headers: { ...headers, receipt: receiptId },
      });
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

    this.Log.info(`Flushing ${pending.length} buffered message(s) for queue ${this.Options.name}`);

    for (const p of pending) {
      this.publishMessage(p.message).then(p.resolve).catch(p.reject);
    }
  }
}
