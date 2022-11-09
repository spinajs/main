import { UnexpectedServerError, InvalidArgument } from '@spinajs/exceptions';
import { IQueueMessage, IQueueConnectionOptions, QueueClient, IMessageRoutingOption, QueueMessageType } from '@spinajs/queue';
import { Client, StompSubscription } from '@stomp/stompjs';
import _ from 'lodash';
import { Injectable, NewInstance } from '@spinajs/di';

Object.assign(global, { WebSocket: require('websocket').w3cwebsocket });

@NewInstance()
@Injectable()
export class StompQueueClient extends QueueClient {
  protected Client: Client;

  protected Subscriptions = new Map<string, StompSubscription>();

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  public async resolve() {
    this.Client = new Client({
      brokerURL: this.Options.host,
      connectHeaders: {
        login: this.Options.login,
        passcode: this.Options.password,
        'client-id': this.Options.name,
      },
      reconnectDelay: 5000,
      heartbeatIncoming: 4000,
      heartbeatOutgoing: 4000,

      // additional options
      ...this.Options.options,
    });

    if (this.Options.debug) {
      this.Client.debug = (str: string) => {
        this.Log.trace(str);
      };
    }

    return new Promise<void>((resolve, reject) => {
      this.Client.onStompError = (frame) => {
        reject(new UnexpectedServerError(`Cannot connect to queue server at ${this.Options.host}`, frame));
      };

      this.Client.onConnect = () => {
        this.Log.success('Connected to STOMP client');

        resolve();

        // when connected override callbacks for loggin

        this.Client.onStompError = (frame) => {
          // Will be invoked in case of error encountered at Broker
          // Bad login/passcode typically will cause an error
          // Complaint brokers will set `message` header with a brief message. Body may contain details.
          // Compliant brokers will terminate the connection after any error
          this.Log.error('Broker reported error: ' + frame.headers['message']);
          this.Log.error('Additional details: ' + frame.body);
        };

        this.Client.onConnect = () => {
          this.Log.success('Connected to STOMP client');
        };

        this.Client.onDisconnect = () => {
          this.Log.warn('Disconnected to STOMP client');
        };

        this.Client.onWebSocketError = (err) => {
          this.Log.warn(err);
        };
      };

      this.Client.onWebSocketError = (err) => {
        reject(new UnexpectedServerError(`Cannot connect to queue server at ${this.Options.host}, websocket error`, err));
      };

      this.Client.activate();
    });
  }

  public async dispose() {
    this.Log.info(`Disposing queue connection ${this.Options.name} ...`);

    return new Promise<void>((resolve) => {
      // if we dont have onDisconnect callback after 5sek, assume we have disconnected
      const t = setTimeout(() => {
        this.Log.warn('STOMP client deactivated, but was not connected before');

        resolve();
      }, 5000);

      this.Client.onDisconnect = () => {
        clearTimeout(t);
        resolve();

        this.Log.success('STOMP client deactivated');
      };

      this.Client.deactivate();
    });
  }

  public async emit(message: IQueueMessage) {
    let routing: string | IMessageRoutingOption = '';

    if (message.Type === QueueMessageType.Job) {
      routing = this.Options.messageRouting ? this.Options.messageRouting[message.Name] ?? this.Options.defaultQueueChannel : this.Options.defaultQueueChannel;
    } else {
      routing = this.Options.messageRouting ? this.Options.messageRouting[message.Name] ?? this.Options.defaultTopicChannel : this.Options.defaultTopicChannel;
    }

    const channel = (routing as IMessageRoutingOption).channel ?? (routing as string);

    this.Client.publish({
      destination: channel,
      body: JSON.stringify(message),
    });

    this.Log.trace(`Published ${message.Type} { Name: ${message.Name}} to channel ${channel}`);
  }

  public unsubscribe(channel: string) {
    if (!this.Subscriptions.has(channel)) {
      return;
    }

    this.Subscriptions.get(channel).unsubscribe();
    this.Subscriptions.delete(channel);
  }

  public subscribe(channel: string, callback: (e: IQueueMessage) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void> {
    if (this.Subscriptions.has(channel)) {
      this.Log.warn(`Channel ${channel} already subscribed !`);
      return;
    }

    const headers: { [key: string]: string } = { ack: 'client' };

    if (subscriptionId) {
      headers.id = subscriptionId;
    }

    if (durable) {
      if (!subscriptionId) {
        throw new InvalidArgument(`subscriptionId cannot be empty if using durable subscriptions`);
      }

      headers['activemq.subscriptionName'] = subscriptionId;
    }

    const subscription = this.Client.subscribe(
      channel,
      (message) => {
        const qMessage: IQueueMessage = JSON.parse(message.body);

        callback(qMessage)
          .then(() => {
            message.ack();
          })
          .catch(() => {
            message.nack();
          });
      },
      headers,
    );

    this.Subscriptions.set(channel, subscription);

    this.Log.success(`Channel ${channel}, durable: ${durable ? 'true' : 'false'} subscribed and ready to receive messages !`);
  }
}
