import type { IRoute, RouteMiddleware } from '../interfaces.js';

/**
 * Whether the route declares its own middleware of the asking instance's kind with other options than `options`, the
 * instance's first constructor argument: a controller or global declaration then stays off the route, so the route's
 * declaration wins. Related either way, so a `DI.register(Mine).as(Theirs)` swap and subclasses on either side match.
 */
export function overriddenByRoute(route: IRoute, self: RouteMiddleware, options: unknown): boolean {
  const kind = self.constructor as abstract new (...args: never[]) => RouteMiddleware;
  const own = route.Middlewares?.find((m) => self instanceof m.Type || m.Type.prototype instanceof kind);
  return own !== undefined && own.Options[0] !== options;
}
