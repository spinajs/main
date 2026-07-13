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

  /**
   * Emit a message. For jobs the generated JobId is returned so the caller can
   * correlate the job with its progress/status (e.g. via queue-http-progress).
   * Returns undefined for non-job messages.
   */
  public abstract emit(event: IQueueMessage | QueueEvent | QueueJob): Promise<string | undefined>;
  public abstract consume<T extends QueueMessage>(event: Constructor<QueueMessage>, callback?: (message: T) => Promise<void>, subscriptionId?: string, durable?: boolean): Promise<void>;
  public abstract stopConsuming(event: Constructor<QueueMessage>): Promise<void>;
  public abstract get(connection?: string): QueueClient;

  protected getConnectionsForMessage(event: IQueueMessage | Constructor<QueueMessage>): string[] {
    const eventName = ((event as IQueueMessage).Name ?? (event as Constructor<QueueMessage>).name) as string;
    const option: string | IMessageRoutingOption | string[] | IMessageRoutingOption[] = ((this.Configuration.routing ?? {}) as any)[eventName] ?? this.Configuration.default;

    if (_.isString(option)) {
      return [this.Configuration.default];
    }

    if (_.isArray(option)) {
      return _.uniq(
        option.map((x): string => {
          if (_.isString(x)) {
            return this.Configuration.default;
          }

          return x.connection ?? this.Configuration.default;
        }),
      );
    } else {
      return [option.connection ?? this.Configuration.default];
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
  public Name: string;

  public Type!: QueueMessageType;

  public Persistent!: boolean;

  public Priority!: number;

  /**
   * The time in milliseconds that a message will wait before being scheduled to be delivered by the broker
   */
  public ScheduleDelay!: number | undefined;

  /**
   * The time in milliseconds to wait after the start time to wait before scheduling the message again
   */
  public SchedulePeriod!: number | undefined;

  /**
   * The number of times to repeat scheduling a message for delivery
   */
  public ScheduleRepeat!: number | undefined;

  /**
   * Use a Cron entry to set the schedule
   */
  public ScheduleCron!: string | undefined;

  constructor(data?: any) {
    if (data) {
      this.hydrate(data);
    }

    this.CreatedAt = DateTime.now();
    this.Name = this.constructor.name;
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
/**
 * Optional richer progress metadata a job may report alongside the numeric
 * percentage - persisted to the job model and exposed by queue-http-progress.
 */
export interface IJobProgressMeta {
  /** Short phase label, e.g. `loading`, `rendering`. */
  phase?: string;
  /** Human-facing status message. */
  message?: string;
}

/**
 * Progress reporter passed to {@link QueueJob.execute}. Call with a 0-100
 * percentage; the optional `meta` carries a phase label / message. Jobs that
 * only report a percentage can ignore `meta`.
 */
export type JobProgressCallback = (p: number, meta?: IJobProgressMeta) => Promise<void>;

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

  public abstract execute(progress: JobProgressCallback): Promise<unknown>;

  /**
   * Emit (enqueue) this job. Returns the generated JobId so the caller can track
   * the job's progress / status (e.g. via queue-http-progress `:jobId/status`).
   */
  public static async emit<T extends typeof QueueMessage>(this: T, val: Partial<InstanceType<T>>, options?: IMessageOptions): Promise<string | undefined> {
    const queue = await DI.resolve(QueueService);

    const message = {
      // jobs must not be lost by default - persist unless the caller opts out.
      // ( val / options below can still override this )
      Persistent: true,
      ...val,
      Type: QueueMessageType.Job,
      CreatedAt: val.CreatedAt ?? DateTime.now(),
      Name: this.name,
      ...options,
    } as IQueueMessage;

    // partial of queue job always is queue message
    return queue.emit(message);
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
   * Dispatches a message to the broker.
   *
   * Delivery-guarantee contract: the returned promise MUST resolve only once the broker has
   * taken custody of the message ( AMQP publisher confirm / STOMP RECEIPT frame ), so callers
   * emitting persistent Jobs get an at-least-once guarantee. Fire-and-forget publishing is only
   * acceptable for non-persistent Events.
   *
   * @param event - message to dispatch
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

  public abstract unsubscribe(event: Constructor<QueueMessage>, removeDurable?: boolean): void;
  public abstract unsubscribe(channel: string, removeDurable?: boolean): void;

  /**
   *
   * Gets dead-letter channel for message from routing table or connection default if non is set.
   * Used by transports to redirect messages that failed processing so they don't block the queue.
   *
   * @param event - event/job to check
   * @returns the dead-letter channel, or undefined if none is configured
   */
  public getDeadLetterChannelForMessage(event: IQueueMessage | Constructor<QueueMessage>): string | undefined {
    const eName = (event as IQueueMessage).Name ?? (event as Constructor<QueueMessage>).name ?? event.constructor.name;
    const rOption = this.Routing?.[eName];

    // a single route option may carry its own dead-letter channel
    if (rOption && !_.isString(rOption) && !_.isArray(rOption) && rOption.deadLetterChannel) {
      return rOption.deadLetterChannel;
    }

    // multiple routes - use the first one that declares a dead-letter channel
    if (_.isArray(rOption)) {
      const withDlq = rOption.find((x) => !_.isString(x) && (x as IMessageRoutingOption).deadLetterChannel) as IMessageRoutingOption | undefined;
      if (withDlq) {
        return withDlq.deadLetterChannel;
      }
    }

    return this.Options.defaultQueueDeadLetterChannel;
  }

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
    const rOption = this.Routing?.[eName];

    if (!rOption) {
      this.Log.warn(`No routing for event ${eName} found, using default channel`);
      return [isJob ? this.Options.defaultQueueChannel! : this.Options.defaultTopicChannel!];
    }

    if (_.isString(rOption)) {
      return [rOption];
    }

    if (_.isArray(rOption)) {
      return _.uniq(
        rOption.map((x): string => {
          if (_.isString(x)) {
            return x;
          }

          return x.channel ?? (isJob ? this.Options.defaultQueueChannel! : this.Options.defaultTopicChannel!);
        }),
      );
    }

    return [rOption.channel ?? (isJob ? this.Options.defaultQueueChannel! : this.Options.defaultTopicChannel!)];
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

  /**
   * Skip re-executing a job whose {@link JobModel} is already in a terminal state
   * ( `success` or `dead` ). Messaging is at-least-once, so duplicates happen on
   * consumer crash and on broker failover - dedup keeps jobs idempotent.
   *
   * Defaults to `true`.
   */
  deduplicate?: boolean;

  /**
   * Automatic cleanup of old tracked jobs ( {@link JobModel} rows ) so the table doesn't
   * grow unbounded. Disabled by default - opt in to avoid silently deleting data.
   */
  retention?: IQueueRetentionOptions;

  /**
   * Throttling of job progress persistence, so a chatty job that reports progress
   * frequently doesn't hammer the DB with a write per callback.
   */
  progress?: IQueueProgressOptions;
}

export interface IQueueProgressOptions {
  /**
   * Minimum progress delta ( % ) between throttled DB writes. Default `5`.
   */
  minDelta?: number;

  /**
   * Minimum time ( ms ) between throttled DB writes. Default `1000`.
   */
  minInterval?: number;
}

export interface IQueueRetentionOptions {
  /**
   * DI service name of the {@link JobRetentionService} implementation that runs the purge.
   * Selected via {@link AutoinjectService}; defaults to `DefaultJobRetentionService`.
   */
  service: string;

  /**
   * Turn the periodic purge on. Default `false`.
   */
  enabled?: boolean;

  /**
   * Age in milliseconds after which a purged job is deleted ( based on CreatedAt ).
   */
  maxAge?: number;

  /**
   * Which statuses to purge. Defaults to terminal statuses ( success / error / dead ).
   */
  statuses?: string[];

  /**
   * How often ( ms ) to run the purge. Default 1 hour.
   */
  interval?: number;
}

/**
 * Runs the periodic cleanup of tracked jobs ( {@link JobModel} rows ) so the table doesn't grow
 * unbounded. The concrete implementation is selected by config ( `queue.retention.service` ) and
 * injected into the {@link QueueService} via {@link AutoinjectService}. Because it is an
 * {@link AsyncService}, DI runs `resolve()` on injection ( where the periodic purge is started )
 * and `dispose()` on teardown ( where it is stopped ).
 */
export abstract class JobRetentionService extends AsyncService implements IMappableService {
  constructor(public Options: IQueueRetentionOptions) {
    super();
  }

  public get ServiceName(): string {
    return this.Options.service;
  }

  /**
   * Deletes tracked jobs ( {@link JobModel} rows ) created before `olderThan` in one of `statuses`.
   * Used by the periodic purge and available for manual cleanup.
   *
   * @param olderThan - delete jobs created before this moment
   * @param statuses - which statuses to purge ( defaults to terminal: success / error / dead )
   * @returns number of deleted rows
   */
  public abstract purgeJobs(olderThan: DateTime, statuses?: string[]): Promise<number>;
}

export interface IMessageRoutingOption {
  channel?: string;
  deadLetterChannel?: string;
  connection?: string;
}

export interface IQueueConnectionOptions {
  transport: string;
  name: string;
  clientId?: string;
  login?: string;
  password?: string;
  host?: string;
  port?: number;
  queue?: string;
  options?: any;
  type: 'event' | 'job';

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

  /**
   * Delay in milliseconds before the transport tries to reconnect after a dropped connection.
   */
  reconnectDelay?: number;

  /**
   * Incoming heartbeat interval in milliseconds ( 0 to disable ).
   */
  heartbeatIncoming?: number;

  /**
   * Outgoing heartbeat interval in milliseconds ( 0 to disable ).
   */
  heartbeatOutgoing?: number;

  /**
   * How long ( ms ) to wait for the initial connection before giving up.
   */
  connectionTimeout?: number;

  /**
   * How long ( ms ) to wait for a broker delivery receipt when emitting a message.
   */
  receiptTimeout?: number;

  /**
   * Base delay ( ms ) for retry backoff when a job fails and is rescheduled.
   * Transports may apply exponential backoff based on this value. 0 means retry immediately.
   */
  retryDelay?: number;

  /**
   * Optional DI service name resolving to an {@link IQueueCredentialsProvider}.
   * When set, the transport asks it for credentials right before each ( re )connect,
   * allowing rotating secrets / token based authentication.
   */
  credentialProvider?: string;
}

/**
 * Provides connection credentials on demand ( e.g. rotating secrets, short lived tokens ).
 * Resolved from DI by the name set in {@link IQueueConnectionOptions.credentialProvider}.
 */
export interface IQueueCredentialsProvider {
  getCredentials(options: IQueueConnectionOptions): Promise<{ login?: string; passcode?: string }>;
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
