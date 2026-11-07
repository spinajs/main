import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { RouteMiddleware, RouteType } from '../interfaces.js';
import type { IController, IReplyContext, IResponseHeader, IRoute } from '../interfaces.js';

/** `Cache-Control: no-store` for one answer's `IResponseOptions.Headers`; {@link NoStore} sets it on every reply of a route. */
export const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

export interface ICacheControlOptions {
  /** `private`: only the browser may keep the reply, no shared cache. `public` otherwise. */
  private?: boolean;
  /** `stale-while-revalidate=<seconds>` (RFC 5861). */
  staleWhileRevalidate?: number;
  /** `immutable` (RFC 8246): the reply never changes while fresh. */
  immutable?: boolean;
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
 * Sets `Cache-Control` on the replies of a GET, HEAD or FILE route: `public, max-age=<maxAge>` (plus the options) on a success,
 * `no-store` on an error reply or a status of 400 and above. A `Cache-Control` the answer or an earlier step already
 * set (an authenticated reply's `no-store`) is kept. With a route and a controller declaration, the route's wins.
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
  protected readonly value: string;

  constructor(maxAge: number = 0, options: ICacheControlOptions = {}) {
    super();
    const parts = [options.private ? 'private' : 'public', `max-age=${seconds('maxAge', maxAge)}`];
    if (options.staleWhileRevalidate !== undefined) {
      parts.push(`stale-while-revalidate=${seconds('staleWhileRevalidate', options.staleWhileRevalidate)}`);
    }
    if (options.immutable) {
      parts.push('immutable');
    }
    this.value = parts.join(', ');
  }

  public override isEnabled(route: IRoute, _controller: IController): boolean {
    return route.Type === RouteType.GET || route.Type === RouteType.HEAD || route.Type === RouteType.FILE;
  }

  public onAfter({ res, response, error }: IReplyContext): void {
    if (res.hasHeader('Cache-Control') || hasCacheControl(response)) {
      return;
    }
    const failed = error !== undefined || response.statusCode >= 400;
    res.setHeader('Cache-Control', failed ? 'no-store' : this.value);
  }
}

/**
 * Sets `Cache-Control: no-store` and `Pragma: no-cache` on every reply of the route, error replies included, over a
 * `Cache-Control` the answer set itself. For answers that hold a secret (a token, a link) no cache may keep.
 * A reply an action wrote to `res` itself does not get them: `onAfter` does not run for it.
 */
@Injectable(RouteMiddleware)
export class NoStore extends RouteMiddleware {
  public onAfter({ res }: IReplyContext): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
}
