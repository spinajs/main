import { Configuration } from '@spinajs/configuration-common';
import { Class, Constructor, DI, ResolveException } from '@spinajs/di';
import { _catch, _chain, _check_arg, _non_empty, _non_nil } from '@spinajs/util';

/**
 *
 * Get configuration value from path
 *
 * @param path
 * @returns
 */
export function _cfg<T>(path: string, defaultValue?: T) {
  _check_arg(_non_empty())(path, 'path');

  return () => _check_arg(_non_nil())(DI.get(Configuration).get<T>(path, defaultValue), path);
}

/**
 * Resolves service from DI container base on path from configuration
 * eg. _service("email.smtp") will resolve service from DI container registered at "email.smtp" path in configuration
 *
 * @param path
 * @returns
 */
export function _service<T>(path: string, type: Class<T>, options?: []): () => Promise<T> {
  return () =>
    _chain(
      _cfg(path),
      _catch(
        ({service} : {service: string}) =>
          _chain(
            () => DI.getRegisteredTypes(type),
            (types: Constructor<unknown>[]) => types.find((t) => t.name === service),
            (t: Constructor<unknown>) => DI.resolve(t, options),
          ),
        (err: Error) => {
          throw new ResolveException(
            `Cannot resolve service from ${path}. Check your configuration file at this path.`,
            err,
          );
        },
      ),
    );
}
