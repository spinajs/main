import Express from 'express';
import { Singleton } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';

import type { IController, IRoute } from './interfaces.js';

/**
 * The parts of an Express router the matchers read; internal to Express 5 (`router` 2.x). `checkRouterInternals()`
 * fails the boot when an Express upgrade changes them.
 */
interface RouteLayer {
  match(path: string): boolean;
  path?: string;
  route?: ExpressRoute;
  handle?: unknown;
}

interface ExpressRoute {
  _handlesMethod(method: string): boolean;
}

interface RouterLike {
  stack: RouteLayer[];
}

type RouteMethods = Record<string, ((...handlers: Express.RequestHandler[]) => unknown) | undefined>;

/** `http:<METHOD> <mounted path>`: the `path` middlewares get for a route. */
export const routeChainName = (route: IRoute, path: string): string => `http:${String(route.Type).toUpperCase()} ${path}`;

const NOOP: Express.RequestHandler = (_req, _res, next) => next();

const isRouter = (handle: unknown): handle is RouterLike => typeof handle === 'function' && Array.isArray((handle as Partial<RouterLike>).stack);

class MalformedPath extends Error {}

/**
 * The routes of `stack` that serve `method` `path`, in the order the router tries them, sub-routers included. Throws
 * MalformedPath where the router would answer 400 (a malformed percent-encoding in a parameter).
 */
function* servingRoutes(stack: readonly RouteLayer[], method: string, path: string): Generator<ExpressRoute> {
  for (const layer of stack) {
    let matched: boolean;
    try {
      // match() overwrites the live layer's path and params; Express reads them synchronously after its own match(),
      // so this must stay synchronous to never run between the two.
      matched = layer.match(path);
    } catch {
      throw new MalformedPath();
    }
    if (!matched) continue;
    if (layer.route) {
      if (layer.route._handlesMethod(method)) yield layer.route;
    } else if (isRouter(layer.handle)) {
      yield* servingRoutes(layer.handle.stack, method, path.slice((layer.path ?? '').length) || '/');
    }
  }
}

function* mountedRoutes(stack: readonly RouteLayer[]): Generator<ExpressRoute> {
  for (const layer of stack) {
    if (layer.route) yield layer.route;
    else if (isRouter(layer.handle)) yield* mountedRoutes(layer.handle.stack);
  }
}

/** The first value `routes` yields, or undefined when the router would answer 400 before reaching one. */
function first<T>(routes: Iterable<T>): T | undefined {
  try {
    for (const route of routes) return route;
  } catch (err) {
    if (!(err instanceof MalformedPath)) throw err;
  }
  return undefined;
}

/** Every value `routes` yields; empty when the router would answer 400, so a caller requiring all of them fails closed. */
function all<T>(routes: Iterable<T>): T[] {
  try {
    return [...routes];
  } catch (err) {
    if (err instanceof MalformedPath) return [];
    throw err;
  }
}

let internalsChecked = false;

/** Fails with a clear message when the Express router no longer matches the way the route lookups rely on. */
export function checkRouterInternals(): void {
  if (internalsChecked) return;
  const router = Express.Router();
  router.route('/a/:b').get(NOOP);
  const stack = (router as unknown as Partial<RouterLike>).stack;
  const works = () =>
    Array.isArray(stack) &&
    typeof stack[0]?.match === 'function' &&
    typeof stack[0]?.route?._handlesMethod === 'function' &&
    first(servingRoutes(stack, 'HEAD', '/A/x/')) === stack[0].route &&
    first(servingRoutes(stack, 'POST', '/a/x')) === undefined &&
    first(servingRoutes(stack, 'GET', '/a/x/y')) === undefined;
  let ok: boolean;
  try {
    ok = works();
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new InvalidOperation(
      'The installed Express router does not expose the internals RouteIndex and the CSRF exempt paths rely on (router.stack, layer.match, route._handlesMethod). Use Express 5 with router 2.x, or report the Express version.',
    );
  }
  internalsChecked = true;
}

/**
 * Paths compiled by an Express router, so a path matches exactly when the router would serve it: params, case,
 * trailing slash, HEAD served by GET. Matched synchronously, since the callers run before routing.
 */
export class RoutePathMatcher<T> {
  private readonly router = Express.Router();
  private readonly values = new Map<object, T>();

  constructor() {
    checkRouterInternals();
  }

  /** Adds `path` for `method`, or for every method when none is given; throws for a path or method Express refuses. */
  public add(path: string, value: T, method?: string): void {
    const route = this.router.route(path);
    if (method === undefined) {
      route.all(NOOP);
    } else {
      const handle = (route as unknown as RouteMethods)[method.toLowerCase()];
      if (typeof handle !== 'function') throw new InvalidOperation(`${method} is not an HTTP method Express routes`);
      handle.call(route, NOOP);
    }
    this.values.set(route, value);
  }

  /** The value of the first path the router would serve `method` `path` with. */
  public match(method: string, path: string): T | undefined {
    const route = first(servingRoutes(this.stack(), method, path));
    return route === undefined ? undefined : this.values.get(route);
  }

  private stack(): RouteLayer[] {
    return (this.router as unknown as RouterLike).stack;
  }
}

/** A registered route, as {@link RouteIndex.match} finds it. */
export interface IRouteMatch {
  readonly route: IRoute;
  readonly controller: IController;
  /** `http:<METHOD> <mounted path>`, as route middlewares get it. */
  readonly path: string;
}

/**
 * Every route the controllers mounted, for code that runs before routing: server middlewares get the match as
 * `ctx.route`, `ctx.controller` and `ctx.path`. It walks the real controllers router, so the order is the router's,
 * a controller added later is matched as soon as it is mounted, and a controller resolved again is matched by the
 * router it is actually served by. Best effort all the same: anything mounted ahead of the controllers (static files,
 * `http.middlewares`) may answer first.
 */
@Singleton()
export class RouteIndex {
  private readonly routes = new WeakMap<object, IRouteMatch>();
  private root?: RouterLike;
  private added = 0;
  private _version = 0;

  constructor() {
    checkRouterInternals();
  }

  /** Changes whenever a route is added or a router mounted, for callers caching what the mounted routes hold. */
  public get version(): number {
    return this._version;
  }

  /** Called by `BaseController.resolve()` with the Express route it mounts `route` on, at `path`. */
  public add(expressRoute: object, controller: IController, route: IRoute, path: string): void {
    this.routes.set(expressRoute, { route, controller, path: routeChainName(route, path) });
    this.added++;
    this._version++;
  }

  /** The router the controllers' routers are mounted on, as the app mounts it (at '/'); a later one replaces it. */
  public mount(router: Express.Router): void {
    if (this.root === (router as unknown as RouterLike)) return;
    this.root = router as unknown as RouterLike;
    this._version++;
  }

  /** Routes were added but no router was mounted: every lookup misses (the controllers router is not the one `Controllers` builds). */
  public get unmounted(): boolean {
    return this.added > 0 && this.root === undefined;
  }

  /** Called after a router was mounted below a root. */
  public mounted(): void {
    this._version++;
  }

  /** The route the router serves `method` `path` (the request's `req.path`) with; undefined for a route it does not know. */
  public match(method: string, path: string): IRouteMatch | undefined {
    const found = this.root ? first(servingRoutes(this.root.stack, method, path)) : undefined;
    return found ? this.routes.get(found) : undefined;
  }

  /**
   * Every mounted route that could serve `method` `path`, in router order. Empty when the router answers the path 400
   * or one of them is a route the index does not know, so a caller requiring something of all of them fails closed.
   */
  public matchAll(method: string, path: string): IRouteMatch[] {
    const serving = this.root ? all(servingRoutes(this.root.stack, method, path)) : [];
    const known = serving.map((route) => this.routes.get(route));
    return known.every((m) => m !== undefined) ? (known as IRouteMatch[]) : [];
  }

  /** Every mounted route the index knows, in router order. */
  public all(): IRouteMatch[] {
    if (!this.root) return [];
    return [...mountedRoutes(this.root.stack)].map((route) => this.routes.get(route)).filter((m): m is IRouteMatch => m !== undefined);
  }
}
