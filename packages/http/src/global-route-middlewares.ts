import { AsyncService, Autoinject, Container, IContainer, Constructor } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { RouteMiddleware } from './interfaces.js';

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
 * Resolves the `http.routes.middlewares` entries, in config order. Every entry is checked before any is resolved.
 */
export async function resolveGlobalRouteMiddlewares(cfg: Configuration, container: IContainer): Promise<RouteMiddleware[]> {
  const entries = cfg.get<unknown[]>(KEY, []) ?? [];

  const resolvable = entries.map((entry) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const { service, options } = entry as { service?: unknown; options?: unknown };
      if (options !== undefined && !Array.isArray(options)) {
        throw new InvalidOption(`${KEY}: options of ${describeEntry(service)} must be an array of constructor arguments`);
      }
      return { type: middlewareType(service, container), options: options as unknown[] | undefined };
    }

    return { type: middlewareType(entry, container), options: undefined };
  });

  return Promise.all(resolvable.map(({ type, options }) => container.resolve<RouteMiddleware>(type, options)));
}

/** The `http.routes.middlewares` instances, resolved once per container and shared by every route. */
export class GlobalRouteMiddlewares extends AsyncService {
  @Autoinject(Configuration)
  protected Cfg!: Configuration;

  @Autoinject(Container)
  protected Container!: IContainer;

  public Middlewares: readonly RouteMiddleware[] = [];

  public async resolve(): Promise<void> {
    await super.resolve();
    this.Middlewares = await resolveGlobalRouteMiddlewares(this.Cfg, this.Container);
  }
}
