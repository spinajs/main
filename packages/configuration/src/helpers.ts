import { Configuration } from '@spinajs/configuration-common';
import { Class, Constructor, get, getRegisteredTypes, resolve, ResolveException } from '@spinajs/di';
import { _check_arg, _non_empty, _non_null, _non_undefined } from '@spinajs/util';

/**
 *
 * Get configuration value from path
 *
 * @param path
 * @returns
 */
export function cfg<T>(path: string, defaultValue?: T): T {
  const configuration = get(Configuration);
  if (!configuration) {
    throw new ResolveException('Configuration service is not registered in DI container, register it to use cfg function');
  }

  _check_arg(_non_empty())(path, 'path');

  // only null / undefined are invalid config values - empty arrays, empty objects
  // and falsy primitives ( 0, '', false ) are legitimate configuration
  return _check_arg(_non_null(), _non_undefined())(configuration.get<T>(path, defaultValue), path);
}

/**
 * Resolves service from DI container base on path from configuration
 * eg. service("email.smtp") will resolve service from DI container registered at "email.smtp" path in configuration
 *
 * @param path
 * @returns
 */
export async function service<T>(path: string, type: Class<T>, options?: []): Promise<T> {
  // configuration errors propagate raw - only resolution errors below are wrapped
  const { service: serviceName } = cfg<{ service: string }>(path);

  try {
    const types = getRegisteredTypes(type);
    const t = types.find((x) => x.name === serviceName);

    if (!t) {
      throw new ResolveException(`Service ${serviceName} is not registered for type ${type.name}`);
    }

    return (await resolve(t as Constructor<unknown>, options)) as T;
  } catch (err) {
    throw new ResolveException(
      `Cannot resolve service from ${path}: ${(err as Error).message}. Check your configuration file at this path.`,
      err,
    );
  }
}
