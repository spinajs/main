import { Configuration } from '@spinajs/configuration-common';
import { DI, ResolveException } from '@spinajs/di';
import { _catch, _chain, _check_arg, _non_empty, _non_nil } from '@spinajs/util';

/**
 * 
 * Get configuration value from path
 * 
 * @param path 
 * @returns 
 */
export function _cfg<T>(path: string) {
  _check_arg(_non_empty())(path, 'path');

  return () => Promise.resolve<T>
    (
      _check_arg(_non_nil())(DI.get(Configuration).get<T>(path), path)
    );
}

/**
 * Resolves service from DI container base on path from configuration
 * eg. _service("email.smtp") will resolve service from DI container registered at "email.smtp" path in configuration
 * 
 * @param path 
 * @returns 
 */
export function _service<T>(path: string): () => Promise<T> {
  return () => _chain(
    _cfg(path),
    _catch(
      (val: string) => DI.resolve(val),
      (err: Error) => {
        throw new ResolveException(
          `Cannot resolve service from ${path}. Check your configuration file at this path.`,
          err,
        );
      },
    ),
  );
}
