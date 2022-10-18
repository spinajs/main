import { InvalidArgument } from '@spinajs/exceptions';
import { IQueueMessage, IQueueConnectionOptions, QueueClient, IMessageRoutingOption } from '@spinajs/Queue';
import { Client, StompSubscription } from '@stomp/stompjs';
import _ from 'lodash';

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
      this.Client.debug = (str) => {
        this.Log.trace(str);
      };
    }

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

    this.Client.activate();
  }

  public async dispose() {
    this.Client.deactivate();
    this.Log.info('STOMP client deactivated');
  }

  public async emit(message: IQueueMessage) {
    if (message.Type === 'job') {
      this._emitJob(message);
    }

    this._emitEvent(message);
  }

  private _emitJob(message: IQueueMessage) {
    const routing = this.Options.messageRouting ? this.Options.messageRouting[message.Name] ?? this.Options.defaultQueueChannel : this.Options.defaultQueueChannel;
    const channel = (routing as IMessageRoutingOption).channel ?? (routing as string);

    this.Client.publish({
      destination: channel,
      body: JSON.stringify(message),
    });

    this.Log.trace(`Published job { Name: ${message.Name}} to channel ${channel}`);
  }

  private _emitEvent(message: IQueueMessage) {
    const routing = this.Options.messageRouting ? this.Options.messageRouting[message.Name] ?? this.Options.defaultTopicChannel : this.Options.defaultTopicChannel;
    const channel = (routing as IMessageRoutingOption).channel ?? (routing as string);

    this.Client.publish({
      destination: channel,
      body: JSON.stringify(message),
    });

    this.Log.trace(`Published event { Name: ${message.Name}} to channel ${channel}`);
  }

  public unsubscribe(channel: string) {
    if (!this.Subscriptions.has(channel)) {
      return;
    }

    this.Subscriptions.get(channel).unsubscribe();
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
