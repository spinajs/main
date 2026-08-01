import { Configuration } from '@spinajs/configuration-common';
import { Class, Constructor, DI, ResolveException } from '@spinajs/di';
import { _catch, _chain, _check_arg, _non_empty, _non_null, _non_undefined } from '@spinajs/util';

/**
 *
 * Get configuration value from path
 *
 * @param path
 * @returns
 */
export function _cfg<T>(path: string, defaultValue?: T) {
  const cfg = DI.get(Configuration);
  if (!cfg) {
    throw new ResolveException('Configuration service is not registered in DI container, register it to use _cfg function');
  }

  _check_arg(_non_empty())(path, 'path');

  // only null / undefined are invalid config values - empty arrays, empty objects
  // and falsy primitives ( 0, '', false ) are legitimate configuration
  return () => _check_arg(_non_null(), _non_undefined())(cfg.get<T>(path, defaultValue), path);
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
        ({ service }: { service: string }) =>
          _chain(
            () => DI.getRegisteredTypes(type),
            (types: Constructor<unknown>[]) => {
              const t = types.find((x) => x.name === service);

              if (!t) {
                throw new ResolveException(`Service ${service} is not registered for type ${type.name}`);
              }

              return t;
            },
            (t: Constructor<unknown>) => DI.resolve(t, options),
          ),
        (err: Error) => {
          throw new ResolveException(
            `Cannot resolve service from ${path}: ${err.message}. Check your configuration file at this path.`,
            err,
          );
        },
      ),
    );
}
