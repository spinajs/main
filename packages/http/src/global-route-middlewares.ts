import { AsyncService, Autoinject, Container, IContainer, Constructor } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { RouteMiddleware } from './interfaces.js';
import type { IMiddlewareDescriptor } from './interfaces.js';

/**
 * One `http.routes.middlewares` entry: the name of a type registered as `RouteMiddleware`, a `RouteMiddleware` class,
 * or either of them with constructor options, as `@Middleware(Class, ...options)` passes them.
 */
export type GlobalRouteMiddlewareEntry = string | Constructor<RouteMiddleware> | { service: string | Constructor<RouteMiddleware>; options?: unknown[] };

const KEY = 'http.routes.middlewares';

function describeEntry(entry: unknown): string {
  return typeof entry === 'function' ? entry.name || '<anonymous class>' : JSON.stringify(entry) ?? String(entry);
}

function middlewareType(service: unknown, container: IContainer): Constructor<RouteMiddleware> {
  if (typeof service === 'string') {
    const type = (container.getRegisteredTypes(RouteMiddleware) ?? []).find((t) => (t as { name?: string }).name === service);
    if (!type) {
      throw new InvalidOption(`${KEY}: no RouteMiddleware named ${service} is registered`);
    }
    return type as Constructor<RouteMiddleware>;
  }

  if (typeof service === 'function') {
    if (!(service.prototype instanceof RouteMiddleware)) {
      throw new InvalidOption(`${KEY}: ${describeEntry(service)} is not a RouteMiddleware`);
    }
    return service as Constructor<RouteMiddleware>;
  }

  throw new InvalidOption(`${KEY}: entry ${describeEntry(service)} is not a RouteMiddleware name, a RouteMiddleware class or { service, options }`);
}

/**
 * Checks the `http.routes.middlewares` entries and turns them into the descriptors `@Middleware` produces, in config
 * order. Instances are made per route, like those of `@Middleware`, so the class's own lifetime decides sharing.
 */
export function globalRouteMiddlewareDescriptors(cfg: Configuration, container: IContainer): IMiddlewareDescriptor[] {
  const entries = cfg.get<unknown[]>(KEY, []) ?? [];

  return entries.map((entry) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const { service, options } = entry as { service?: unknown; options?: unknown };
      if (options !== undefined && !Array.isArray(options)) {
        throw new InvalidOption(`${KEY}: options of ${describeEntry(service)} must be an array of constructor arguments`);
      }
      return { Type: middlewareType(service, container), Options: (options as unknown[] | undefined) ?? [] };
    }

    return { Type: middlewareType(entry, container), Options: [] };
  });
}

/** The checked `http.routes.middlewares` descriptors, read once per container, before the first route is built. */
export class GlobalRouteMiddlewares extends AsyncService {
  @Autoinject(Configuration)
  protected Cfg!: Configuration;

  @Autoinject(Container)
  protected Container!: IContainer;

  public Descriptors: readonly IMiddlewareDescriptor[] = [];

  public async resolve(): Promise<void> {
    await super.resolve();
    this.Descriptors = globalRouteMiddlewareDescriptors(this.Cfg, this.Container);
  }
}
