import type { JobOptions } from './hooks.js';

export interface IEventOption {
  /**
   * Should event survive consumer restart ?
   */
  durable?: boolean;
}

/**
 *
 * Mark class as job
 *
 * @param opts - `runAs` selects whose authority the handler runs with; a `QueueMessageHook` interprets it
 */
export function Job(opts?: JobOptions) {
  return (target: any) => {
    if (!Reflect.hasMetadata('queue:options', target)) {
      Reflect.defineMetadata(
        'queue:options',
        {
          ...opts,
          type: 'job',
        },
        target,
      );
    }
  };
}

/**
 * The `@Job` options of a message's class. A `runAs` other than the two known values is dropped:
 * the job then runs with no authority.
 */
export function jobOptions(message: object): JobOptions {
  const options: { runAs?: unknown } | undefined = Reflect.getMetadata('queue:options', message.constructor);
  return options?.runAs === 'initiator' || options?.runAs === 'system' ? { runAs: options.runAs } : {};
}

/**
 * Mark class as event
 *
 * @param connection - event connection name for use, if not set default connection is used
 */
export function Event(options?: IEventOption) {
  return (target: any) => {
    if (!Reflect.hasMetadata('queue:options', target)) {
      Reflect.defineMetadata(
        'queue:options',
        {
          ...options,
          type: 'event',
        },
        target,
      );
    }
  };
}
