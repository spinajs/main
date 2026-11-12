import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { RouteMiddleware, RouteType } from '../interfaces.js';
import type { IController, IMiddlewareContext, IReplyContext, IResponseHeader, IRoute } from '../interfaces.js';

/** `Cache-Control: no-store` for one answer's `IResponseOptions.Headers`; {@link NoStore} sets it on every reply of a route. */
export const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

export interface ICacheControlOptions {
  /** `public`: a shared cache may keep the reply even to a request with `Authorization`. Off by default. */
  public?: boolean;
  /** `private`: only the browser may keep the reply. */
  private?: boolean;
  /** `stale-while-revalidate=<seconds>` (RFC 5861). */
  staleWhileRevalidate?: number;
  /** `immutable` (RFC 8246): the reply never changes while fresh. */
  immutable?: boolean;
  /** Marks 3xx replies (other than 304) too; by default a redirect is left alone. */
  redirects?: boolean;
}

function seconds(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgument(`CacheControl ${name} must be a non-negative integer of seconds, got ${String(value)}`);
  }
  return value;
}

function hasCacheControl(response: IReplyContext['response']): boolean {
  return response.headers.some((h) => h.Name.toLowerCase() === 'cache-control');
}

/**
 * Sets `Cache-Control` on the replies of a GET, HEAD or FILE route: `max-age=<maxAge>` (plus the options) on a 2xx or
 * 304, `no-store` on an error reply or a status of 400 and above; a redirect is left alone unless `redirects` is set.
 * A reply to a request with `Authorization`, or one that sets a cookie, is downgraded to `private`. A `Cache-Control`
 * the answer or an earlier step already set (an authenticated reply's `no-store`) is kept. With a route and a
 * controller declaration, the route's wins.
 *
 * ```ts
 * @Get()
 * @Middleware(CacheControl, 300, { staleWhileRevalidate: 60 })
 * public categories() { ... }
 * ```
 */
@NewInstance()
@Injectable(RouteMiddleware)
export class CacheControl extends RouteMiddleware {
  protected readonly scope: 'public' | 'private' | undefined;
  protected readonly directives: string;
  protected readonly redirects: boolean;

  constructor(maxAge: number = 0, options: ICacheControlOptions = {}) {
    super();
    if (options.public && options.private) {
      throw new InvalidArgument('CacheControl takes public or private, not both');
    }
    this.scope = options.public ? 'public' : options.private ? 'private' : undefined;
    const parts = [`max-age=${seconds('maxAge', maxAge)}`];
    if (options.staleWhileRevalidate !== undefined) {
      parts.push(`stale-while-revalidate=${seconds('staleWhileRevalidate', options.staleWhileRevalidate)}`);
    }
    if (options.immutable) {
      parts.push('immutable');
    }
    this.directives = parts.join(', ');
    this.redirects = options.redirects === true;
  }

  public override isEnabled(route: IRoute, _controller: IController): boolean {
    return route.Type === RouteType.GET || route.Type === RouteType.HEAD || route.Type === RouteType.FILE;
  }

  public onAfter({ req, res, response, error }: IReplyContext): void {
    if (res.hasHeader('Cache-Control') || hasCacheControl(response)) {
      return;
    }
    const status = response.statusCode ?? 200;
    if (error !== undefined || status >= 400) {
      res.setHeader('Cache-Control', 'no-store');
      return;
    }
    if (status >= 300 && status !== 304 && !this.redirects) {
      return;
    }
    // RFC 9111 3.5 keeps a reply to an Authorization request out of shared caches unless public; a cookie would be
    // handed to every client of a shared cache
    const personal = req.headers.authorization !== undefined || res.hasHeader('Set-Cookie') || response.cookies.length > 0;
    const scope = personal ? 'private' : this.scope;
    res.setHeader('Cache-Control', scope ? `${scope}, ${this.directives}` : this.directives);
  }
}

/**
 * Sets `Cache-Control: no-store` and `Pragma: no-cache` on every reply of the route: before the route runs, so a reply
 * the action writes to `res` itself has them too, and again on every framework reply, error replies included, over a
 * `Cache-Control` the answer set itself. For answers that hold a secret (a token, a link) no cache may keep.
 */
@Injectable(RouteMiddleware)
export class NoStore extends RouteMiddleware {
  public onBefore({ res }: IMiddlewareContext): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }

  public onAfter({ res }: IReplyContext): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
}
