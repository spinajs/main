import { Config } from '@spinajs/configuration';
import { AsyncModule, DI, Inject } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { EventBase, MessageBase, QueueConfiguration, QueueTransport } from './interfaces';

export * from './interfaces';
export * from './decorators';

export class Queue extends AsyncModule {
  @Logger('queue')
  protected Log: Log;

  @Config('queue')
  protected Configuration: QueueConfiguration;

  protected Transports: QueueTransport[];

  @Inject(EventBase)
  protected Events: EventBase[];

  public async resolveAsync(): Promise<void> {
    for (const c of this.Configuration.connections) {
      this.Log.trace(`Found connection ${c.name}, transport: ${c.transport}`);

      const connection = (await DI.resolve)<QueueTransport>(c.transport, [c]);
      this.Transports.push(connection);
    }

    await super.resolveAsync();
  }

  /**
   *
   * Dispatches event to all transports that are configured for handle channel specified in event.
   *
   * @param event - event to dispatch
   */
  public async dispatch(event: MessageBase) {
    /**
     * Dispatch to transports that can handle message channel
     */
    const transports = this.Transports.filter((x) => {
      if (x.Channels.indexOf('*') !== -1) return true;
      return x.Channels.indexOf(event.Channel) !== -1;
    });

    if (transports.length === 0) {
      throw new UnexpectedServerError(`Cannot find event transport for channel ${event.channel}`);
    }

    for (const t of transports) {
      await t.dispatch(event);
    }
  }

  /**
   *
   * Subscribes for receiving events for specified connections.
   *
   * It must be run explicitly, becouse we dont want to subscribe all channels & connections at once.
   * For most time we want run one subscriber per process for efficiency
   *
   * @param connection - connection name
   */
  public async subscribe(connectionName: string) {
    const transport = this.Transports.find((x) => x.Options.name === connectionName);
    if (!transport) {
      throw new UnexpectedServerError(`No connection for ${connectionName}`);
    }

    await transport.subscribe((message) => {
      const event = this.Events.filter((x) => {
        if (x.Channels.indexOf('*') !== -1) return true;
        return x.Channels.indexOf(message.Channel) !== -1;
      });

      if (!event) {
        this.Log.warn(`No event subscribed for ${message.Channel} channel`);
      }

      event.forEach((x) => x.execute(message));
    });
  }
}
