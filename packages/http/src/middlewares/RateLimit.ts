import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { DEFAULT_IPV6_PREFIX, throttleIp } from '@spinajs/util';

import { Middleware } from '../decorators.js';
import { RouteMiddleware } from '../interfaces.js';
import type { IController, IMiddlewareContext, IRoute, MiddlewareStage, Response } from '../interfaces.js';
import { rateLimitAnswer, retryAfterSeconds, setRateLimitHeaders, tooManyRequests } from './rate-limit-answer.js';
import { ThrottleStore } from './Throttle.js';

/** What one request is counted against: its client address, or its authenticated principal. */
export type RateLimitKey = 'ip' | 'principal';

export interface IRateLimitSettings {
  limit: number;
  windowSeconds: number;
  by?: RateLimitKey;
}

export interface IRateLimitOptions {
  /** Config path read once when the route is mounted: an IRateLimitSettings object (merged over `default`), or `false` = this route has no limit. */
  config?: string;
  /** Used when `config` is absent or the key is not set. Required when `config` is given. */
  default?: IRateLimitSettings;
  /** Inline settings when no config is used. */
  limit?: number;
  windowSeconds?: number;
  by?: RateLimitKey;
  /**
   * The throttled answer. Default: the 429 E_TOO_MANY_REQUESTS body. It sets its own headers (e.g. Retry-After). A
   * closed route (`limit: 0`) passes `windowSeconds`.
   */
  answer?: (retryAfterSeconds: number) => Response;
  /** false: send no X-RateLimit-* headers and no middleware-set Retry-After (answer decides). Default true. */
  headers?: boolean;
  /**
   * Custom counting key for this route (e.g. a session handle); undefined falls back to `by`. Prefixed with the route
   * key; must not contain secrets in clear (hash them).
   */
  key?: (ctx: IMiddlewareContext) => string | undefined;
}

interface IPrincipalLike {
  type?: unknown;
  id?: unknown;
  authenticated?: unknown;
}

const SETTINGS_KEYS: readonly string[] = ['limit', 'windowSeconds', 'by'];

const show = (v: unknown): string => (typeof v === 'string' ? `'${v}'` : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

function checkSettings(settings: IRateLimitSettings, refuse: (name: string, problem: string) => Error): Required<IRateLimitSettings> {
  const { limit, windowSeconds, by = 'ip' } = settings;
  if (!(Number.isInteger(limit) && limit >= 0)) throw refuse('limit', `must be an integer >= 0, got ${show(limit)}`);
  if (!(typeof windowSeconds === 'number' && Number.isFinite(windowSeconds) && windowSeconds > 0)) throw refuse('windowSeconds', `must be a finite positive number, got ${show(windowSeconds)}`);
  if (by !== 'ip' && by !== 'principal') throw refuse('by', `must be 'ip' or 'principal', got ${show(by)}`);
  return { limit, windowSeconds, by };
}

const defined = (settings: Partial<IRateLimitSettings>): Partial<IRateLimitSettings> => Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));

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

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Config('http.throttle.ipv6Prefix', { defaultValue: DEFAULT_IPV6_PREFIX })
  protected Ipv6Prefix: unknown;

  protected readonly options: Readonly<IRateLimitOptions>;

  /** false: the config turned the limit off. */
  private settings?: Required<IRateLimitSettings> | false;
  private route = '';
  private prefix = DEFAULT_IPV6_PREFIX;

  constructor(limit: number, windowSeconds: number, by?: RateLimitKey);
  constructor(options: IRateLimitOptions);
  constructor(limitOrOptions: number | IRateLimitOptions, windowSeconds?: number, by: RateLimitKey = 'ip') {
    super();
    this.options = typeof limitOrOptions === 'object' && limitOrOptions !== null ? { ...limitOrOptions } : { limit: limitOrOptions, windowSeconds, by };
  }

  /** The effective settings once the route is mounted; before that, the ones written in code. */
  public get limit(): number {
    return this.current().limit as number;
  }

  public get windowSeconds(): number {
    return this.current().windowSeconds as number;
  }

  public get by(): RateLimitKey {
    return this.current().by ?? 'ip';
  }

  public override isEnabled(_route: IRoute, _controller: IController): boolean {
    try {
      return this.resolveSettings() !== false;
    } catch {
      // mounted, so onRegister refuses the route with the error and the route's name
      return true;
    }
  }

  public onRegister(route: IRoute, path: string): void {
    const settings = this.resolveSettings();
    if (settings === false) return;

    const prefix = this.Ipv6Prefix ?? DEFAULT_IPV6_PREFIX;
    if (!(Number.isInteger(prefix) && (prefix as number) >= 16 && (prefix as number) <= 128)) throw new InvalidOption('http.throttle.ipv6Prefix must be an integer from 16 to 128');
    this.prefix = prefix as number;

    this.route = `rate:${String(route.InternalType).toUpperCase()} ${path}:${settings.limit}/${settings.windowSeconds}`;
  }

  public async onBefore(ctx: IMiddlewareContext): Promise<Response | void> {
    const settings = this.settings;
    if (!settings) return;

    const { res } = ctx;
    const { answer } = this.options;
    const headers = this.options.headers !== false;

    // A closed route never opens, so a window reset or Retry-After would only invite a pointless retry.
    if (settings.limit === 0) {
      if (headers) {
        res.set('X-RateLimit-Limit', '0');
        res.set('X-RateLimit-Remaining', '0');
      }
      return answer ? answer(settings.windowSeconds) : tooManyRequests();
    }

    // A store failure rejects: the request fails closed through the error answer.
    const hit = await this.Store.increment(`${this.route}:${this.subject(ctx, settings.by)}`, settings.windowSeconds);
    if (headers && !answer) return rateLimitAnswer(res, settings.limit, hit);
    if (headers) setRateLimitHeaders(res, settings.limit, hit);
    if (hit.count <= settings.limit) return;

    const retryAfter = retryAfterSeconds(hit);
    if (headers) res.set('Retry-After', String(retryAfter));
    return answer ? answer(retryAfter) : tooManyRequests().setHeader('Retry-After', String(retryAfter));
  }

  private current(): Partial<IRateLimitSettings> {
    if (this.settings) return this.settings;
    return { ...this.options.default, ...defined({ limit: this.options.limit, windowSeconds: this.options.windowSeconds, by: this.options.by }) };
  }

  private resolveSettings(): Required<IRateLimitSettings> | false {
    if (this.settings !== undefined) return this.settings;

    const { config, limit, windowSeconds, by } = this.options;
    const inline = defined({ limit, windowSeconds, by });
    if (config === undefined) {
      return (this.settings = checkSettings({ ...this.options.default, ...inline } as IRateLimitSettings, (name, problem) => new InvalidArgument(`@RateLimit ${name} ${problem}`)));
    }

    if (Object.keys(inline).length > 0) throw new InvalidArgument(`@RateLimit({ config: '${config}' }) takes its settings from config and default, not inline ${Object.keys(inline).join(', ')}`);
    const fallback = this.options.default;
    if (typeof fallback !== 'object' || fallback === null) throw new InvalidArgument(`@RateLimit({ config: '${config}' }) needs a default`);
    const base = checkSettings(fallback, (name, problem) => new InvalidArgument(`@RateLimit default.${name} ${problem}`));

    const configured = this.Configuration.get<unknown>(config);
    if (configured === false) return (this.settings = false);
    if (configured === undefined || configured === null) return (this.settings = base);

    if (typeof configured !== 'object' || Array.isArray(configured)) throw new InvalidOption(`${config} must be { limit, windowSeconds, by } or false, got ${show(configured)}`);
    const unknown = Object.keys(configured).filter((k) => !SETTINGS_KEYS.includes(k));
    if (unknown.length > 0) throw new InvalidOption(`${config} has unknown keys ${unknown.join(', ')}; allowed: ${SETTINGS_KEYS.join(', ')}`);

    return (this.settings = checkSettings({ ...fallback, ...defined(configured as Partial<IRateLimitSettings>) } as IRateLimitSettings, (name, problem) => new InvalidOption(`${config}.${name} ${problem}`)));
  }

  private subject(ctx: IMiddlewareContext, by: RateLimitKey): string {
    const { req, storage } = ctx;
    const custom = this.options.key?.(ctx);
    if (typeof custom === 'string' && custom !== '') return `key:${custom}`;

    if (by === 'principal') {
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
 * The options form reads the numbers from configuration (`false` there takes the limit off the route), and can
 * replace the throttled answer, drop the headers or count on a key of its own.
 *
 * ```ts
 * @Post()
 * @RateLimit(5, 300)
 * public resetPassword() { ... }
 *
 * @Post()
 * @RateLimit({ config: 'app.rateLimit.login', default: { limit: 30, windowSeconds: 60 }, answer: throttledLogin, headers: false })
 * public login() { ... }
 * ```
 */
export function RateLimit(limit: number, windowSeconds: number, by?: RateLimitKey): ReturnType<typeof Middleware>;
export function RateLimit(options: IRateLimitOptions): ReturnType<typeof Middleware>;
export function RateLimit(limitOrOptions: number | IRateLimitOptions, windowSeconds?: number, by: RateLimitKey = 'ip'): ReturnType<typeof Middleware> {
  return typeof limitOrOptions === 'number' ? Middleware(RateLimitMiddleware, limitOrOptions, windowSeconds, by) : Middleware(RateLimitMiddleware, limitOrOptions);
}
