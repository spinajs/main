import type { Constructor } from '@spinajs/di';
import type { IRoute, RouteMiddleware } from '../interfaces.js';

/**
 * Whether the route declares its own `type` with other options than `options`, the first constructor argument of the
 * instance asking: a controller or global declaration then stays off the route, so the route's declaration wins.
 */
export function overriddenByRoute(route: IRoute, type: Constructor<RouteMiddleware>, options: unknown): boolean {
  const own = route.Middlewares?.find((m) => m.Type === type);
  return own !== undefined && own.Options[0] !== options;
}
