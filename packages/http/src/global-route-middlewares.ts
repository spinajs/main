import type { IContainer, Constructor } from '@spinajs/di';
import type { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { RouteMiddleware } from './interfaces.js';
import type { IMiddlewareDescriptor } from './interfaces.js';
import { describeConfigEntry, resolveConfiguredTypes } from './configured-types.js';

/**
 * One `http.routes.middlewares` entry: the name of a type registered as `RouteMiddleware`, a `RouteMiddleware` class,
 * or either of them with constructor options, as `@Middleware(Class, ...options)` passes them.
 */
export type GlobalRouteMiddlewareEntry = string | Constructor<RouteMiddleware> | { service: string | Constructor<RouteMiddleware>; options?: unknown[] };

const KEY = 'http.routes.middlewares';

/**
 * Checks the `http.routes.middlewares` entries and turns them into the descriptors `@Middleware` produces, in config
 * order. Instances are made per route, like those of `@Middleware`, so the class's own lifetime decides sharing.
 * Called by every controller before it builds its routes.
 */
export function globalRouteMiddlewareDescriptors(cfg: Configuration, container: IContainer): IMiddlewareDescriptor[] {
  const entries = cfg.get<unknown[]>(KEY, []) ?? [];

  return resolveConfiguredTypes(KEY, RouteMiddleware, entries, container).map(({ type, options }) => {
    if (options !== undefined && !Array.isArray(options)) {
      throw new InvalidOption(`${KEY}: options of ${describeConfigEntry(type)} must be an array of constructor arguments`);
    }
    return { Type: type, Options: (options as unknown[] | undefined) ?? [] };
  });
}
