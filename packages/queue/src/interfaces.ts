import { AsyncModule } from '@spinajs/di';
import { ISerializationDescriptor, ISerializable, Serialize } from './decorators';
import { DateTime } from 'luxon';
import _ from 'lodash';

export abstract class EventBase {
  /**
   * Events can be dispatched into channels.
   * Given connection can hook up for one or more channels, or all. It
   * means that it will push further events that are send to specified channels.
   *
   * Awaible channel names are:
   *  * - all incoming events
   *  channel1, channel2, .... -  list of channels
   *  channel1 - one channel
   *
   *  eg. pushing / subscribing to queue server all events related to user creation will be:
   *  'user:creation'
   */
  public abstract get Channels(): string[];

  public abstract execute(message: MessageBase): Promise<void>;
}

/**
 * Events are messages send via queue, we do not want to track it, dont care about result, no retry policy on failed execution etc.
 */
export abstract class MessageBase {
  [key: string]: any;

  @Serialize()
  public CreatedAt: DateTime;

  public Channel: string;

  constructor(channel: string) {
    this.CreatedAt = DateTime.now();
    this.Channel = channel;
  }

  public hydrate(payload: any) {
    const sdesc: ISerializationDescriptor = Reflect.getMetadata('event:serialization', this);
    if (!sdesc || !payload) {
      return;
    }

    for (const prop of sdesc.Properties) {
      this[prop] = payload[prop];
    }
  }

  toJSON() {
    const sdesc: ISerializationDescriptor = Reflect.getMetadata('event:serialization', this);
    const data: ISerializable = {};

    if (!sdesc) {
      return data;
    }

    for (const prop of sdesc.Properties) {
      data[prop] = this[prop];
    }

    return data;
  }
}

export abstract class QueueTransport extends AsyncModule {
  /**
   * Transport options
   */
  public Options: Connection;

  public Channels: string[];

  constructor(options: Connection) {
    super();

    this.Options = options;
    this.Channels = this.Options.channel.split('.');
  }

  /**
   *
   * Dispatches event to queue
   *
   * @param event - event to dispatch
   */
  public abstract dispatch(event: MessageBase): Promise<boolean>;

  /**
   *
   * Subscribes to queue and process invoming events
   *
   */
  public abstract subscribe(callback: (message: MessageBase) => void): Promise<void>;
}

export interface QueueConfiguration {
  connections: Connection[];
}

export interface Connection {
  transport: string;

  /**
   * Events can be dispatched into channels.
   * Given connection can hook up for one or more channels, or all. It
   * means that it will push further events that are send to specified channels.
   *
   * Awaible channel names are:
   *  * - all incoming events
   *  channel1, channel2, .... - comma separated list of channels
   *  channel1 - one channel
   *
   *  eg. pushing / subscribing to queue server all events related to user creation will be:
   *  'user:creation'
   */
  channel: string;
  name: string;
  login?: string;
  password?: string;
  host?: string;
  port?: number;
  queue?: string;

  options?: any;
}
