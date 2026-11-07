import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { DEFAULT_IPV6_PREFIX, throttleIp } from '@spinajs/util';

import { Middleware } from '../decorators.js';
import { RouteMiddleware } from '../interfaces.js';
import type { IMiddlewareContext, IRoute, MiddlewareStage, Response } from '../interfaces.js';
import { rateLimitAnswer, tooManyRequests } from './rate-limit-answer.js';
import { ThrottleStore } from './Throttle.js';

/** What one request is counted against: its client address, or its authenticated principal. */
export type RateLimitKey = 'ip' | 'principal';

interface IPrincipalLike {
  type?: unknown;
  id?: unknown;
  authenticated?: unknown;
}

/**
 * A fixed-window limit on one route, counted in the {@link ThrottleStore} `ThrottleMiddleware` uses. Each route keeps
 * its own counter, keyed by the method and the mounted path, the limit and the window, so two `@RateLimit`s on a
 * route (a burst and a sustained limit) count apart.
 *
 * `by: 'principal'` counts the authenticated principal (`req.storage.Principal` from authz-http, else
 * `req.storage.AuthnPrincipal`); an anonymous request is counted per address.
 *
 * Registered as `RouteMiddleware`, so `http.routes.middlewares: [{ service: 'RateLimitMiddleware', options: [600, 60] }]`
 * gives every route its own limit.
 */
@NewInstance()
@Injectable(RouteMiddleware)
export class RateLimitMiddleware extends RouteMiddleware {
  // right after the policy gate, before the route's other middlewares spend anything on the request
  public override readonly Stage: MiddlewareStage = 'outer';

  @Autoinject(ThrottleStore)
  protected Store!: ThrottleStore;

  @Config('http.throttle.ipv6Prefix', { defaultValue: DEFAULT_IPV6_PREFIX })
  protected Ipv6Prefix: unknown;

  private route = '';
  private prefix = DEFAULT_IPV6_PREFIX;

  constructor(public readonly limit: number, public readonly windowSeconds: number, public readonly by: RateLimitKey = 'ip') {
    super();
  }

  public onRegister(route: IRoute, path: string): void {
    if (!(Number.isInteger(this.limit) && this.limit >= 0)) throw new InvalidArgument(`@RateLimit limit must be an integer >= 0, got ${this.limit}`);
    if (!(Number.isFinite(this.windowSeconds) && this.windowSeconds > 0)) throw new InvalidArgument(`@RateLimit windowSeconds must be a finite positive number, got ${this.windowSeconds}`);
    if (this.by !== 'ip' && this.by !== 'principal') throw new InvalidArgument(`@RateLimit by must be 'ip' or 'principal', got ${String(this.by)}`);

    const prefix = this.Ipv6Prefix ?? DEFAULT_IPV6_PREFIX;
    if (!(Number.isInteger(prefix) && (prefix as number) >= 16 && (prefix as number) <= 128)) throw new InvalidOption('http.throttle.ipv6Prefix must be an integer from 16 to 128');
    this.prefix = prefix as number;

    this.route = `rate:${String(route.InternalType).toUpperCase()} ${path}:${this.limit}/${this.windowSeconds}`;
  }

  public async onBefore({ req, res, storage }: IMiddlewareContext): Promise<Response | void> {
    // A closed route never opens, so a window reset or Retry-After would only invite a pointless retry.
    if (this.limit === 0) {
      res.set('X-RateLimit-Limit', '0');
      res.set('X-RateLimit-Remaining', '0');
      return tooManyRequests();
    }
    // A store failure rejects: the request fails closed through the error answer.
    const hit = await this.Store.increment(`${this.route}:${this.subject(req, storage)}`, this.windowSeconds);
    return rateLimitAnswer(res, this.limit, hit);
  }

  private subject(req: IMiddlewareContext['req'], storage: IMiddlewareContext['storage']): string {
    if (this.by === 'principal') {
      const s = storage as unknown as { Principal?: IPrincipalLike | null; AuthnPrincipal?: IPrincipalLike | null } | undefined;
      const principal = s?.Principal ?? s?.AuthnPrincipal;
      if (principal?.authenticated === true && typeof principal.id === 'string') {
        // Escaped as @spinajs/principal's principalKey does, so the type/id split stays unambiguous.
        return `principal:${String(principal.type).replace(/%/g, '%25').replace(/:/g, '%3A')}:${principal.id}`;
      }
    }
    // Never req.ip: under express's own `trust proxy` it would come from a client-set X-Forwarded-For (SR-03).
    return `ip:${throttleIp(storage?.realIp ?? req.socket?.remoteAddress ?? 'unknown', this.prefix)}`;
  }
}

/**
 * Limits the route (or every route of the controller) to `limit` requests per `windowSeconds`, per client address or
 * per authenticated principal. Over the limit it answers 429 with `Retry-After`, the body `ThrottleMiddleware` sends;
 * every counted request gets the `X-RateLimit-*` headers.
 *
 * ```ts
 * @Post()
 * @RateLimit(5, 300)
 * public resetPassword() { ... }
 * ```
 */
export const RateLimit = (limit: number, windowSeconds: number, by: RateLimitKey = 'ip') => Middleware(RateLimitMiddleware, limit, windowSeconds, by);
