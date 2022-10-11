import { AsyncService } from '@spinajs/di';
import { ISerializationDescriptor, ISerializable, Serialize } from './decorators';
import { DateTime } from 'luxon';
import _ from 'lodash';
import { ListFromFiles } from '@spinajs/reflection';
import { Log, Logger } from '@spinajs/log';

export interface IQueueMessage<T> {
  CreatedAt: DateTime;
  Payload: T;
  Name: string;
  Type: 'job' | 'event';
}

export interface IQueueJob<T> extends IQueueMessage<T> {
  RetryCount: number;
  Delay: number;
}

/**
 * Events are messages send via queue, we do not want to track it, dont care about result, no retry policy on failed execution etc.
 */
export abstract class QueueMessage<T> implements IQueueMessage<T> {
  [key: string]: any;

  public CreatedAt: DateTime;

  public Payload: T;

  public Name: string;

  public Type: 'job' | 'event';

  constructor(public Connection?: string) {
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
export abstract class QueueEvent<T> extends QueueMessage<T> {}

/**
 * Jobs are executed only once even if multiple listeners waiting for it. usually used for single method call
 * or time consuming tasks, that need to checked for result and tracked
 */
export abstract class QueueJob<T> extends QueueMessage<T> implements IQueueJob<T> {
  public abstract execute(): Promise<boolean>;

  /**
   * Retry count on job failure
   */
  @Serialize()
  public RetryCount: number;

  /**
   * Execution delay in miliseconds
   */
  @Serialize()
  public Delay: number;
}

export abstract class QueueClient extends AsyncService {
  @Logger('queue')
  protected Log: Log;

  /**
   * Transport options
   */
  public Options: IConnection;

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.jobs')
  protected Jobs: QueueJob<any>[];

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.events')
  protected Events: QueueJob<any>[];

  constructor(options: IConnection) {
    super();

    this.Options = options;
  }

  /**
   *
   * Dispatches event to queue
   *
   * @param event - event to dispatch
   */
  public abstract emit<T>(event: IQueueMessage<T>): Promise<boolean>;

  /**
   *
   * Subscribes to queue and process incoming events
   *
   */
  public abstract subscribe<T>(connection: string, callback: (e: IQueueMessage<T>) => Promise<boolean>): Promise<void>;

  public abstract unsubscribe<T>(connection: string, callback: (e: IQueueMessage<T>) => Promise<boolean>): Promise<void>;
}

export interface IQueueConfiguration {
  default: string;
  connections: IConnection[];
}

export interface IConnection {
  transport: string;
  name: string;
  login?: string;
  password?: string;
  host?: string;
  port?: number;
  queue?: string;
  options?: any;
  type: 'event' | 'job';
}
