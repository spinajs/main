import { InvalidArgument } from '@spinajs/exceptions';
import { Route } from '@spinajs/http';
import type { IControllerDescriptor, IRoute } from '@spinajs/http';
import { ResponseCacheMiddleware } from './middleware.js';
import { resolveResponseCacheOptions } from './options.js';
import type { ResolvedResponseCacheOptions, ResponseCacheOptions } from './options.js';

/** `Controller.method`: the target is the controller's prototype for an instance method, the class for a static one. */
function routeName(target: unknown, propertyKey: string | symbol | undefined): string {
  let owner = 'a controller';
  if (typeof target === 'function') {
    owner = target.name;
  } else if (typeof target === 'object' && target !== null) {
    owner = target.constructor.name;
  }
  return `${owner}.${String(propertyKey)}`;
}

/** resolveResponseCacheOptions knows no route, so its refusal is given the route's name here. */
function resolvedFor(options: ResponseCacheOptions, target: unknown, propertyKey: string | symbol | undefined): ResolvedResponseCacheOptions {
  try {
    return resolveResponseCacheOptions(options);
  } catch (err) {
    if (!(err instanceof InvalidArgument)) throw err;
    throw new InvalidArgument(`${routeName(target, propertyKey)}: ${err.message}`, err.fieldName, err.errorCode, err);
  }
}

/**
 * Stores the JSON reply of a GET route for `ttl` and answers later requests with the same key from the store, per
 * principal unless `scope` says otherwise. The policies run on every request. Options are checked where the decorator
 * is applied, so a wrong one fails at import and names the route.
 */
export function ResponseCache(options: ResponseCacheOptions): MethodDecorator {
  return Route((_: IControllerDescriptor, route: IRoute | null, target: unknown, propertyKey?: string | symbol) => {
    if (!route) {
      throw new InvalidArgument('@ResponseCache goes on a route method, not on a controller');
    }
    // a second @ResponseCache (or a subclass re-decorating an inherited route) replaces the first
    const entry = { Type: ResponseCacheMiddleware, Options: [resolvedFor(options, target, propertyKey)] };
    const i = route.Middlewares.findIndex((m) => m.Type === ResponseCacheMiddleware);
    if (i >= 0) {
      route.Middlewares.splice(i, 1, entry);
    } else {
      route.Middlewares.push(entry);
    }
  }) as MethodDecorator;
}
