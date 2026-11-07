import Express from 'express';

import type { IController, IRoute } from './interfaces.js';

/** The parts of an Express router layer the matcher uses; internal to Express 4 and 5 alike. */
interface RouteLayer {
  match(path: string): boolean;
  route?: object & { _handlesMethod(method: string): boolean };
}

type RouteMethods = Record<string, ((...handlers: Express.RequestHandler[]) => unknown) | undefined>;

/** `http:<METHOD> <mounted path>`: the `path` middlewares get for a route. */
export const routeChainName = (route: IRoute, path: string): string => `http:${String(route.Type).toUpperCase()} ${path}`;

const NOOP: Express.RequestHandler = (_req, _res, next) => next();

/**
 * Paths compiled by an Express router, so a path matches exactly when the router would serve it: params, case,
 * trailing slash, HEAD served by GET. Matched synchronously against the router's layers, since the callers run
 * before routing and must not wait for the router's deferred dispatch.
 */
export class RoutePathMatcher<T> {
  private readonly router = Express.Router();
  private readonly values = new Map<object, T>();

  /** Adds `path` for `method`, or for every method; throws what Express throws for a path it cannot compile. */
  public add(path: string, value: T, method?: string): void {
    const route = this.router.route(path);
    const handle = method === undefined ? undefined : (route as unknown as RouteMethods)[method.toLowerCase()];
    if (typeof handle === 'function') handle.call(route, NOOP);
    else route.all(NOOP);
    this.values.set(route, value);
  }

  /** The value of the first path the router would serve `method` `path` with. */
  public match(method: string, path: string): T | undefined {
    for (const layer of (this.router as unknown as { stack: RouteLayer[] }).stack) {
      let matched: boolean;
      try {
        matched = layer.match(path);
      } catch {
        // A malformed percent-encoding in a parameter: the router answers 400, so nothing matches.
        return undefined;
      }
      if (matched && layer.route?._handlesMethod(method) === true) return this.values.get(layer.route);
    }
    return undefined;
  }
}

/** A registered route, as {@link RouteIndex.match} finds it. */
export interface IRouteMatch {
  readonly route: IRoute;
  readonly controller: IController;
  /** `http:<METHOD> <mounted path>`, as route middlewares get it. */
  readonly path: string;
}

interface IIndexedRoute extends IRouteMatch {
  readonly mounted: string;
}

/**
 * Every route the controllers registered, by method and mounted path, for code that runs before routing: server
 * middlewares get the match as `ctx.route`, `ctx.controller` and `ctx.path`. Best effort: the route that answers is
 * the router's, and anything mounted ahead of the controllers (static files, `http.middlewares`) may answer first.
 */
export class RouteIndex {
  private entries: IIndexedRoute[] = [];
  private matcher?: RoutePathMatcher<IIndexedRoute>;

  /** Called by `BaseController.resolve()` for each route it mounts at `path`, in mount order. */
  public add(controller: IController, route: IRoute, path: string): void {
    this.entries.push({ route, controller, path: routeChainName(route, path), mounted: path });
    this.matcher = undefined;
  }

  /** Drops every route of `controller`; a controller resolved again registers its routes anew. */
  public remove(controller: IController): void {
    const kept = this.entries.filter((e) => e.controller !== controller);
    if (kept.length === this.entries.length) return;
    this.entries = kept;
    this.matcher = undefined;
  }

  /** The route the router would serve `method` `path` (the request's `req.path`) with. */
  public match(method: string, path: string): IRouteMatch | undefined {
    if (this.entries.length === 0) return undefined;
    return (this.matcher ??= this.build()).match(method, path);
  }

  private build(): RoutePathMatcher<IIndexedRoute> {
    const matcher = new RoutePathMatcher<IIndexedRoute>();
    for (const entry of this.entries) matcher.add(entry.mounted, entry, String(entry.route.InternalType));
    return matcher;
  }
}
