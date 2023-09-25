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
 * @param connection - job connection name for use, if not set default connection is used
 */
export function Job() {
  return (target: any) => {
    if (!Reflect.hasMetadata('queue:options', target)) {
      Reflect.defineMetadata(
        'queue:options',
        {
          type: 'job',
        },
        target,
      );
    }
  };
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
