/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { Configuration } from './types';

/**
 * Injects configuration value to given class property
 *
 * @param path - path to configuration value eg. "app.dirs.stats"
 * @param dafaultValue - default value if path not exists
 * @returns
 */
export function Config(path: string, dafaultValue?: unknown) {
  return (target?: any, key?: string): any => {
    let config: Configuration = null;

    const getter = () => {
      if (!config) {
        config = DI.get(Configuration);
      }
      return config.get(path, dafaultValue);
    };

    Object.defineProperty(target, key, {
      get: getter,
      enumerable: false,
      configurable: false,
    });
  };
}
