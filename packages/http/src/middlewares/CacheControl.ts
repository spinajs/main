import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { appendVary } from '../caching.js';
import { FIELD_NAME_PATTERN } from '../headers.js';
import { RouteMiddleware, RouteType } from '../interfaces.js';
import type { IController, IMiddlewareContext, IReplyContext, IResponseHeader, IRoute } from '../interfaces.js';

/** `Cache-Control: no-store` for one answer's `IResponseOptions.Headers`; {@link NoStore} sets it on every reply of a route. */
export const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

export interface ICacheControlOptions {
  /** `public`: shared caches may keep the reply. A reply to a request with `Authorization`, or one that sets a cookie, is still `private`. Off by default. */
  public?: boolean;
  /** `private`: only the browser may keep the reply. */
  private?: boolean;
  /** `stale-while-revalidate=<seconds>` (RFC 5861). */
  staleWhileRevalidate?: number;
  /** `immutable` (RFC 8246): the reply never changes while fresh. */
  immutable?: boolean;
  /** Marks 3xx replies (other than 304) too; by default a redirect is left alone. */
  redirects?: boolean;
  /** Request headers the reply depends on, added to `Vary` on every reply except an error reply marked `no-store` here. `['*']` alone: no cache may reuse it. */
  vary?: readonly string[];
}

function seconds(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgument(`CacheControl ${name} must be a non-negative integer of seconds, got ${String(value)}`);
  }
  return value;
}

function varyOf(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  const items: readonly unknown[] = Array.isArray(value) ? value : [];
  const fields = items.filter((f): f is string => typeof f === 'string' && (f === '*' || FIELD_NAME_PATTERN.test(f)));
  if (!Array.isArray(value) || fields.length !== items.length) {
    throw new InvalidArgument(`CacheControl vary must be a list of request header names, got ${JSON.stringify(value)}`);
  }
  if (fields.length > 1 && fields.includes('*')) {
    throw new InvalidArgument("CacheControl vary takes '*' alone");
  }
  return fields;
}

function hasCacheControl(response: IReplyContext['response']): boolean {
  return response.headers.some((h) => h.Name.toLowerCase() === 'cache-control');
}

/**
 * Sets `Cache-Control` on the replies of a GET, HEAD or FILE route: `max-age=<maxAge>` (plus the options) on a 2xx or
 * 304, `no-store` on an error reply or a status of 400 and above; a redirect is left alone unless `redirects` is set.
 * A reply to a request with `Authorization`, or one that sets a cookie, is downgraded to `private`. A `Cache-Control`
 * the answer or an earlier step already set (an authenticated reply's `no-store`) is kept. With a route and a
 * controller declaration, the route's wins. `vary` adds to the `Vary` of every reply except an error reply marked
 * `no-store` here.
 *
 * ```ts
 * @Get()
 * @Middleware(CacheControl, 300, { staleWhileRevalidate: 60, vary: ['Accept-Language'] })
 * public categories() { ... }
 * ```
 */
@NewInstance()
@Injectable(RouteMiddleware)
export class CacheControl extends RouteMiddleware {
  protected readonly scope: 'public' | 'private' | undefined;
  protected readonly directives: string;
  protected readonly redirects: boolean;
  protected readonly vary: readonly string[];

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
    this.vary = varyOf(options.vary);
  }

  public override isEnabled(route: IRoute, _controller: IController): boolean {
    return route.Type === RouteType.GET || route.Type === RouteType.HEAD || route.Type === RouteType.FILE;
  }

  public onAfter({ req, res, response, error }: IReplyContext): void {
    const status = response.statusCode ?? 200;
    const failed = error !== undefined || status >= 400;
    const kept = res.hasHeader('Cache-Control') || hasCacheControl(response);
    // an error reply that brought its own Cache-Control may be kept by a cache, so it needs the Vary too
    if (!failed || kept) {
      appendVary(res, response, this.vary);
    }
    if (kept) {
      return;
    }
    const value = failed ? 'no-store' : this.cacheControlFor(req, res, response, status);
    if (value !== undefined) {
      res.setHeader('Cache-Control', value);
    }
  }

  /** The value of a reply that did not fail; undefined leaves a redirect alone. */
  protected cacheControlFor(req: IReplyContext['req'], res: IReplyContext['res'], response: IReplyContext['response'], status: number): string | undefined {
    if (status >= 300 && status !== 304 && !this.redirects) {
      return undefined;
    }
    // RFC 9111 3.5: a shared cache keeps a reply to an Authorization request only when told to, and this middleware
    // never tells it so; a cookie would be handed to every client of a shared cache
    const personal = req.headers.authorization !== undefined || res.hasHeader('Set-Cookie') || response.cookies.length > 0;
    const scope = personal ? 'private' : this.scope;
    return scope ? `${scope}, ${this.directives}` : this.directives;
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
