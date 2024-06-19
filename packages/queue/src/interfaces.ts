import { AsyncService, Constructor, DI, IInstanceCheck, IMappableService } from '@spinajs/di';
import { DateTime } from 'luxon';
import _ from 'lodash';
import { Log, Logger } from '@spinajs/log';
import { Config } from '@spinajs/configuration';

export enum QueueMessageType {
  Job = 'JOB',
  Event = 'EVENT',
}

export interface IQueueMessage {
  CreatedAt: DateTime;
  Name: string;
  Type: QueueMessageType;

  Persistent: boolean;

  Priority: number;

  /**
   * The time in milliseconds that a message will wait before being scheduled to be delivered by the broker
   */
  ScheduleDelay?: number;

  /**
   * The time in milliseconds to wait after the start time to wait before scheduling the message again
   */
  SchedulePeriod?: number;

  /**
   * The number of times to repeat scheduling a message for delivery
   */
  ScheduleRepeat?: number;

  /**
   * Use a Cron entry to set the schedule
   */
  ScheduleCron?: string;
}

export interface IQueueJob extends IQueueMessage {
  RetryCount: number;
  JobId?: string;
}

export abstract class QueueService extends AsyncService {
  @Config('queue')
  protected Configuration: IQueueConfiguration;

  public abstract emit(event: IQueueMessage | QueueEvent | QueueJob): Promise<void>;
  public abstract consume<T extends QueueMessage>(event: Constructor<QueueMessage>, callback?: (message: T) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void>;
  public abstract stopConsuming(event: Constructor<QueueMessage>): Promise<void>;
  public abstract get(connection?: string): QueueClient;

  protected getConnectionsForMessage(event: IQueueMessage | Constructor<QueueMessage>): string[] {
    const option = this.Configuration.routing[(event as IQueueMessage).Name ?? (event as Constructor<QueueMessage>).name] ?? this.Configuration.default;

    if (_.isString(option)) {
      return [this.Configuration.default];
    }

    if (_.isArray(option)) {
      return _.uniq(
        option.map((x) => {
          if (_.isString(x)) {
            return this.Configuration.default;
          }

          if (x.connection) {
            return x.connection;
          }
        }),
      );
    }
  }
}

export function isJob(event: IQueueMessage): event is QueueJob {
  return event.Type === QueueMessageType.Job;
}

/**
 * Events are messages send via queue, we do not want to track it, dont care about result, no retry policy on failed execution etc.
 */
export abstract class QueueMessage implements IQueueMessage {
  [key: string]: any;

  public CreatedAt: DateTime;

  // event name
  // defaults to class name
  public get Name(): string{ 

    // default name is class name
    return this.constructor.name;
  }

  public Type: QueueMessageType;

  public Persistent: boolean;

  public Priority: number;

  /**
   * The time in milliseconds that a message will wait before being scheduled to be delivered by the broker
   */
  public ScheduleDelay: number;

  /**
   * The time in milliseconds to wait after the start time to wait before scheduling the message again
   */
  public SchedulePeriod: number;

  /**
   * The number of times to repeat scheduling a message for delivery
   */
  public ScheduleRepeat: number;

  /**
   * Use a Cron entry to set the schedule
   */
  public ScheduleCron: string;

  constructor(data?: any) {
    if (data) {
      this.hydrate(data);
    }

    this.CreatedAt = DateTime.now();
  }

  public hydrate(payload: any) {
    Object.assign(this, payload);
  }
}

/**
 * events provides a simple observer implementation, allowing you to subscribe and listen
 * for various events that occur in your application. Events serve as a great way to decouple
 * various aspects of your application, since a single event can have multiple listeners that do not depend on each other.
 *
 * we can register multiple listeners for a single event and the event helper will dispatch the event to all of its registered
 * listeners without us calling them explicitly. where in case of Jobs we would have to call them each one explicitly.
 */
export abstract class QueueEvent extends QueueMessage {
  constructor(data?: any) {
    super(data);

    this.Type = QueueMessageType.Event;
  }

  public static async emit<T extends typeof QueueMessage>(this: T, val: Partial<InstanceType<T>>, options?: IMessageOptions): Promise<void> {
    const queue = await DI.resolve(QueueService);

    const message = {
      ...val,
      Type: QueueMessageType.Event,
      CreatedAt: val.CreatedAt ?? DateTime.now(),
      Name: this.name,
      ...options,
    } as IQueueMessage;

    // partial of queue job always is queue message
    await queue.emit(message);
  }
}

/**
 * Jobs are executed only once even if multiple listeners waiting for it. usually used for single method call
 * or time consuming tasks, that need to checked for result and tracked
 *
 * Job results are preserved
 */
export abstract class QueueJob extends QueueMessage implements IQueueJob {
  public JobId: string;

  /**
   * Retry count on job failure
   */
  public RetryCount: number;

  constructor() {
    super();

    this.Type = QueueMessageType.Job;
  }

  public abstract execute(progress: (p: number) => Promise<void>): Promise<unknown>;

  public static async emit<T extends typeof QueueMessage>(this: T, val: Partial<InstanceType<T>>, options?: IMessageOptions): Promise<void> {
    const queue = await DI.resolve(QueueService);

    const message = {
      ...val,
      Type: QueueMessageType.Job,
      CreatedAt: val.CreatedAt ?? DateTime.now(),
      Name: this.name,
      ...options,
    } as IQueueMessage;

    // partial of queue job always is queue message
    await queue.emit(message);
  }
}

export abstract class QueueClient extends AsyncService implements IInstanceCheck, IMappableService {
  @Logger('queue')
  protected Log: Log;

  @Config('queue.routing')
  protected Routing: IQueueMessageRoutingOptions;

  public get Name(): string {
    return this.Options.name;
  }

  public get ServiceName() {
    return this.Options.name;
  }

  constructor(public Options: IQueueConnectionOptions) {
    super();
  }

  public __checkInstance__(creationOptions: any): boolean {
    return this.Options.name === creationOptions[0].name;
  }

  /**
   *
   * Dispatches event to queue
   *
   * @param event - event to dispatch
   */
  public abstract emit(event: IQueueMessage): Promise<void>;

  /**
   *
   * Subscribes to ALL channels that event is assignet to in routing table
   *
   */
  public abstract subscribe(event: Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void>;

  /**
   * Subscribes for specific channel in queue server
   *
   * @param channel - specified channel to subscribe
   * @param callback - callback executet when message arrives
   * @param subscriptionId - id to identify subscription when using durable events
   * @param durable - is durable event ?
   */
  public abstract subscribe(channel: string, callback: (e: IQueueMessage) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void>;

  public abstract unsubscribe(event: Constructor<QueueMessage>): void;
  public abstract unsubscribe(channel: string): void;

  /**
   *
   * Gets event channel from routing table or default if non is set
   *
   * @param event - event to check
   */
  public getChannelForMessage(event: IQueueMessage | Constructor<QueueMessage>): string[] {
    const options = Reflect.getMetadata('queue:options', event);
    const eName = (event as IQueueMessage).Name ?? (event as Constructor<QueueMessage>).name ?? event.constructor.name;
    const isJob = (event as IQueueMessage).Type ? (event as IQueueMessage).Type === QueueMessageType.Job : options ? options.type === 'job' : false;
    const rOption = this.Routing[eName];

    if (!rOption) {

      this.Log.warn(`No routing for event ${eName} found, using default channel`);
      return [isJob ? this.Options.defaultQueueChannel : this.Options.defaultTopicChannel];
    }

    if (_.isString(rOption)) {
      return [rOption];
    }

    if (_.isArray(rOption)) {
      return _.uniq(
        rOption.map((x) => {
          if (_.isString(x)) {
            return x;
          }

          return x.channel ?? isJob ? this.Options.defaultQueueChannel : this.Options.defaultTopicChannel;
        }),
      );
    }

    return [rOption.channel ?? isJob ? this.Options.defaultQueueChannel : this.Options.defaultTopicChannel];
  }
}

export interface IQueueMessageRoutingOptions {
  [key: string]: string | IMessageRoutingOption | string[] | IMessageRoutingOption[];
}

export interface IQueueConfiguration {
  default: string;
  /**
   * Message routing eg. where event/job with given type ( name ) will be send to
   * eg. job Email will be sent to /task/mails channel in broker
   * If no routing for message is provided, it will be sent to default one.
   *
   * Also here deat letter channel for message can be configured
   *
   * Message can be router in multiple destinations
   */
  routing?: IQueueMessageRoutingOptions;
  connections: IQueueConnectionOptions[];
}

export interface IMessageRoutingOption {
  channel?: string;
  deadLetterChannel?: string;
  connection?: string;
}

export interface IQueueConnectionOptions {
  transport: string;
  name: string;
  login?: string;
  password?: string;
  host?: string;
  port?: number;
  queue?: string;
  options?: any;
  type: 'event' | 'job';
  debug?: boolean;

  /**
   * Default topic ( events ) channel in broker
   * If no routing for specified event is provided
   * it will be send to this channel
   */
  defaultTopicChannel?: string;

  /**
   * Default queue ( job ) channel in broker
   * If no routing for specified job is provided
   * it will be send to this channel
   */
  defaultQueueChannel?: string;

  /**
   * If job fails at client side and we dont send ack
   * broker will try to send job again ( and probably will fail again )
   * In such event, it will reschedule job to deat letter queue for further processing
   * and for unblocking source queue
   */
  defaultQueueDeadLetterChannel?: string;
}

export interface IMessageOptions {
  Persistent: boolean;

  Priority: number;

  /**
   * The time in milliseconds that a message will wait before being scheduled to be delivered by the broker
   */
  ScheduleDelay: number;

  /**
   * The time in milliseconds to wait after the start time to wait before scheduling the message again
   */
  SchedulePeriod: number;

  /**
   * The number of times to repeat scheduling a message for delivery
   */
  ScheduleRepeat: number;

  /**
   * Use a Cron entry to set the schedule
   */
  ScheduleCron: string;
}
