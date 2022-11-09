export interface IEventOption {
  durable?: boolean;
  connection?: string;
}
/**
 *
 * Mark class as job
 *
 * @param connection - job connection name for use, if not set default connection is used
 */
export function Job(connection?: string) {
  return (target: any) => {
    if (!Reflect.hasMetadata('queue:options', target)) {
      Reflect.defineMetadata(
        'queue:options',
        {
          connection,
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
