import { AsyncService } from '@spinajs/di';
import { ISerializationDescriptor, ISerializable, Serialize } from './decorators';
import { DateTime } from 'luxon';
import _ from 'lodash';
import { ListFromFiles } from '@spinajs/reflection';
import { Log, Logger } from '@spinajs/log';

/**
 * Events are messages send via queue, we do not want to track it, dont care about result, no retry policy on failed execution etc.
 */
export abstract class Message<T> {
  [key: string]: any;

  @Serialize()
  public CreatedAt: DateTime;

  @Serialize()
  public Payload: T;

  @Serialize()
  public Name: string;

  constructor(public Connection?: string) {
    this.CreatedAt = DateTime.now();
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

/**
 * events provides a simple observer implementation, allowing you to subscribe and listen
 * for various events that occur in your application. Events serve as a great way to decouple
 * various aspects of your application, since a single event can have multiple listeners that do not depend on each other.
 *
 * we can register multiple listeners for a single event and the event helper will dispatch the event to all of its registered
 * listeners without us calling them explicitly. where in case of Jobs we would have to call them each one explicitly.
 */
export abstract class Event<T> extends Message<T> {}

/**
 * Jobs are executed only once even if multiple listeners waiting for it. usually used for single method call
 * or time consuming tasks, that need to checked for result and tracked
 */
export abstract class Job<T> extends Message<T> {
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
  public Options: Connection;

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.jobs')
  protected Jobs: Job<any>[];

  constructor(options: Connection) {
    super();

    this.Options = options;
  }

  /**
   *
   * Dispatches event to queue
   *
   * @param event - event to dispatch
   */
  public abstract emit<T>(event: Event<T>): Promise<boolean>;

  /**
   *
   * Dispatches job
   *
   * @param job - job to dispatch
   */
  public abstract emitJob<T>(job: Job<T>): Promise<boolean>;

  /**
   *
   * Subscribes to queue and process invoming events
   *
   */
  public abstract subscribe<T>(event: string, callback: (e: Event<T>) => Promise<boolean>): Promise<void>;

  public abstract unsubscribe<T>(event: string, callback: (e: Event<T>) => Promise<boolean>): Promise<void>;
}

export interface QueueConfiguration {
  default: string;
  connections: Connection[];
}

export interface Connection {
  transport: string;
  name: string;
  login?: string;
  password?: string;
  host?: string;
  port?: number;
  queue?: string;
  options?: any;
}
