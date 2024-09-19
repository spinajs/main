import { UnexpectedServerError, InvalidArgument } from '@spinajs/exceptions';
import { IQueueMessage, IQueueConnectionOptions, QueueClient, QueueMessage } from '@spinajs/queue';
import Stomp from '@stomp/stompjs';
import _ from 'lodash';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import websocket from 'websocket';

Object.assign(global, { WebSocket: websocket.w3cwebsocket });



@PerInstanceCheck()
@Injectable(QueueClient)
export class StompQueueClient extends QueueClient {
  protected Client: Stomp.Client;

  protected Subscriptions = new Map<string, Stomp.StompSubscription>();

  public get ClientId() {
    return this.Options.clientId ?? this.Options.name;
  }

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  public async resolve() {
    this.Client = new Stomp.Client({
      brokerURL: this.Options.host,
      connectHeaders: {
        login: this.Options.login,
        passcode: this.Options.password,
        'client-id': this.ClientId,
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
        this.Log.success('Connected to STOMP client, client-id: ' + this.ClientId);

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
        this.Log.error(`Websocket error: ${JSON.stringify(err)}`);
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

    channels.forEach((c) => {
      this.Client.publish({
        destination: c,
        body: JSON.stringify(message),
        headers,
      });

      this.Log.trace(`Published ${message.Type} Name: ${message.Name}} to channel ${c} ( ${this.Options.name} )`);
    });
  }

  public unsubscribe(channelOrMessage: string | Constructor<QueueMessage>) {
    const channels = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    channels.forEach((c) => {
      if (!this.Subscriptions.has(c)) {
        return;
      }

      this.Subscriptions.get(c).unsubscribe();
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

      const headers: { [key: string]: string } = { ack: 'client', 'activemq.prefetchSize': '1' };

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
        c,
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

      this.Subscriptions.set(c, subscription);

      this.Log.success(`Channel ${c}, durable: ${durable ? 'true' : 'false'} subscribed and ready to receive messages !`);
    });
  }
}
