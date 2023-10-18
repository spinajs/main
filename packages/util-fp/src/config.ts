import { Configuration } from '@spinajs/Configuration';
import { Effect, Option } from 'effect';
import { Util as DI } from './di.js';

export namespace Util {
  export namespace Config {
    /**
     * Get config value for given property. If value not exists it returns default value, if default value is not provided returns undefined
     *
     * @param path - path to property eg. ["system","dirs"]
     * @param defaultValue - optional, if value at specified path not exists returns default value
     */
    export function get<T>(path: string[] | string, defaultValue?: T) {
      return DI.Di.resolve(Configuration).pipe(Effect.flatMap((conf) => Option.fromNullable(conf.get(path, defaultValue))));
    }
  }
}
