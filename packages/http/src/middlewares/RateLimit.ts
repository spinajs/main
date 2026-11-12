import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { _between, _custom, _finite, _gte, _integer, _is_number, _is_object, _is_string, _non_empty, _one_of, _or, _positive, _try_check_arg, DEFAULT_IPV6_PREFIX, throttleIp } from '@spinajs/util';

import { Middleware } from '../decorators.js';
import { RouteMiddleware } from '../interfaces.js';
import type { IController, IDocumentedAnswer, IMiddlewareContext, IRoute, IRouteMiddlewareDoc, MiddlewareStage, Response } from '../interfaces.js';
import { answerDocOf, quietRateLimitAnswer, rateLimitAnswer, rateLimitHeadersDoc, retryAfterDoc, retryAfterSeconds, setRateLimitHeaders, tooManyRequests, tooManyRequestsDoc } from './rate-limit-answer.js';
import { ThrottleStore } from './Throttle.js';

/** What one request is counted against: its client address, or its authenticated principal. */
export type RateLimitKey = 'ip' | 'principal';

export interface IRateLimitSettings {
  limit: number;
  windowSeconds: number;
  by?: RateLimitKey;
  /** Read from config (or `default`), it wins over the decorator's `headers`. */
  headers?: boolean;
}

/** Settings with their defaults filled in; `headers` stays optional, so a table of defaults need not name it. */
export type RateLimitDefault = Required<Pick<IRateLimitSettings, 'limit' | 'windowSeconds' | 'by'>> & { headers?: boolean };

/**
 * The `headers` the routes of a configured limit declare in code. `false`: they never send `X-RateLimit-*`, and
 * `headers` is no configurable key. `true`: they send them unless the config says otherwise. Unset: the config decides.
 */
export interface RateLimitSchemaOptions {
  headers?: boolean;
}

export interface IRateLimitOptions {
  /**
   * Config path read once when the route is mounted: an IRateLimitSettings object (merged over `default`), or `false` =
   * this route has no limit, not even a global `http.routes.middlewares` one. `{ limit: 0 }` closes the route instead.
   * `config: false` itself (no other option) declares the route unlimited in code: on a route, it also takes the
   * controller's `@RateLimit` off that route.
   */
  config?: string | false;
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
  /**
   * true: send the X-RateLimit-* headers on every counted response, and set Retry-After on the throttled one next to
   * `answer`. Default false: the default 429 carries only its own Retry-After, and an `answer` decides. A configured
   * `headers` wins over this one; `false` also keeps `headers` out of the keys the config may set.
   */
  headers?: boolean;
  /**
   * Custom counting key for this route (e.g. a session handle); undefined falls back to `by`. Prefixed with the route
   * key. A key read from the request limits per value the client sends, so a client that varies it is never limited:
   * derive it from server-validated state, or keep an ip limit next to it. Stored in clear: hash secrets, with an HMAC
   * keyed by a server secret for low-entropy values (login names, emails).
   */
  key?: (ctx: IMiddlewareContext) => string | undefined;
}

interface IPrincipalLike {
  type?: unknown;
  id?: unknown;
  authenticated?: unknown;
}

const SETTINGS_KEYS: readonly string[] = ['limit', 'windowSeconds', 'by'];
const OPTION_KEYS: readonly string[] = ['config', 'default', ...SETTINGS_KEYS, 'answer', 'headers', 'key'];

/** The keys a configured limit (or `default`) may set: `headers` only where the route has not ruled it out in code. */
const settingsKeys = (opts?: RateLimitSchemaOptions): readonly string[] => (opts?.headers === false ? SETTINGS_KEYS : [...SETTINGS_KEYS, 'headers']);

const show = (v: unknown): string => (typeof v === 'string' ? `'${v}'` : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

type Refuse = (message: string) => Error;
type ArgCheck = (arg: any, name: string) => unknown;

const argument: Refuse = (message) => new InvalidArgument(message);
const option: Refuse = (message) => new InvalidOption(message);

/** The util checks throw InvalidArgument; a value read from config is refused with InvalidOption instead. */
function check(validator: ArgCheck, value: unknown, name: string, refuse: Refuse): void {
  const [valid, error] = _try_check_arg(validator)(value, name);
  if (!valid) throw refuse(`${(error as Error).message}, got ${show(value)}`);
}

const optional =
  (validator: ArgCheck): ArgCheck =>
  (arg: unknown, name) =>
    arg === undefined ? undefined : validator(arg, name);

const isFunction = (name: string) => optional(_custom((v) => typeof v === 'function', new InvalidArgument(`${name} should be a function`)));

// The types do not hold for options given in JSON config, and `number` admits NaN, 1.5 and -1.
const LIMIT = _is_number(_integer(), _gte(0));
const WINDOW_SECONDS = _is_number(_finite(), _positive());
const BY = _one_of(['ip', 'principal']);
// not _is_boolean: it passes 0 and 1
const HEADERS = optional(_one_of([true, false]));

function checkSettings(settings: IRateLimitSettings, label: string, refuse: Refuse): RateLimitDefault {
  const { limit, windowSeconds, by = 'ip', headers } = settings;
  check(LIMIT, limit, `${label}limit`, refuse);
  check(WINDOW_SECONDS, windowSeconds, `${label}windowSeconds`, refuse);
  check(BY, by, `${label}by`, refuse);
  check(HEADERS, headers, `${label}headers`, refuse);
  return headers === undefined ? { limit, windowSeconds, by } : { limit, windowSeconds, by, headers };
}

/** The declaration `@RateLimit({ config: false })`. */
function isDeclaredOff(m: { Type: unknown; Options?: unknown[] }): boolean {
  const type = m.Type as { prototype?: unknown } | undefined;
  const isRateLimit = type === RateLimitMiddleware || (typeof type === 'function' && type.prototype instanceof RateLimitMiddleware);
  const options = m.Options?.[0] as IRateLimitOptions | undefined;
  return isRateLimit && m.Options?.length === 1 && typeof options === 'object' && options !== null && options.config === false;
}

/**
 * The JSON schema of one configured limit (`<package>.rateLimit.<name>`, read by `@RateLimit({ config })`): settings merged
 * over `defaults`, or `false` for none. Schema only: the middleware checks the value again when the route mounts.
 * `opts.headers: false` (the route's own `@RateLimit({ headers: false })`) leaves `headers` out of the accepted keys.
 */
export function rateLimitSchema(defaults: Readonly<IRateLimitSettings>, route: string, opts?: RateLimitSchemaOptions): Record<string, unknown> {
  const keys = settingsKeys(opts);
  return {
    default: { ...defaults },
    description: `The limit of ${route}: { ${keys.join(', ')} } merged over the default, or false for none.`,
    anyOf: [
      { enum: [false] },
      {
        type: 'object',
        // propertyNames, not additionalProperties: removeAdditional would drop a misspelt key without a word.
        propertyNames: { enum: [...keys] },
        properties: {
          limit: { type: 'integer', minimum: 0 },
          windowSeconds: { type: 'number', exclusiveMinimum: 0 },
          by: { enum: ['ip', 'principal'] },
          ...(keys.includes('headers') ? { headers: { type: 'boolean' } } : {}),
        },
      },
    ],
  };
}

/** The shipped limit of each configured route group of a package, by name. */
export type RateLimitDefaults<N extends string = string> = Readonly<Record<N, RateLimitDefault>>;

/**
 * The JSON schema of a package's `rateLimit` object: one {@link rateLimitSchema} entry per name in `defaults` (with
 * `opts`), an unknown name refused.
 */
export function rateLimitsSchema<N extends string>(defaults: RateLimitDefaults<N>, routes: Readonly<Record<N, string>>, description?: string, opts?: RateLimitSchemaOptions) {
  return {
    type: 'object',
    default: {},
    propertyNames: { enum: Object.keys(defaults) },
    properties: Object.fromEntries((Object.keys(defaults) as N[]).map((name) => [name, rateLimitSchema(defaults[name], routes[name], opts)])),
    description: description ?? `Per-route @RateLimit settings: { ${settingsKeys(opts).join(', ')} } over the shipped default, or false for no limit.`,
  };
}

/**
 * A `@RateLimit` factory over the config keys `<root>.<name>`, each over `defaults[name]`. A route takes no `headers`
 * of its own. `opts.headers: false` keeps `headers` off every route of the factory and, passed to
 * {@link rateLimitsSchema} too, out of the schema; `true` only sends them unless the config says otherwise.
 */
export function configuredRateLimit<N extends string>(root: string, defaults: RateLimitDefaults<N>, opts: RateLimitSchemaOptions = {}) {
  return (name: N, options: Pick<IRateLimitOptions, 'answer' | 'key'> = {}): ReturnType<typeof RateLimit> => RateLimit({ ...options, config: `${root}.${name}`, default: defaults[name], ...(opts.headers !== undefined ? { headers: opts.headers } : {}) });
}

/** A marked `answer`, with the headers `onBefore` sets on `res` next to it when the route sends `X-RateLimit-*`. */
function customAnswerDoc(answer: unknown, closed: boolean, headers: boolean): Record<string, IDocumentedAnswer> | undefined {
  const doc = answerDocOf(answer);
  if (!doc) return undefined;
  const sent = { ...(doc.retryAfter || (headers && !closed) ? retryAfterDoc() : {}), ...(headers ? rateLimitHeadersDoc(closed) : {}) };
  return { [String(doc.status)]: { description: doc.description, ...(doc.type !== undefined ? { type: doc.type } : {}), ...(Object.keys(sent).length > 0 ? { headers: sent } : {}) } };
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
  private settings?: RateLimitDefault | false;
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

  public override isEnabled(route: IRoute, _controller: IController): boolean {
    // A route declared unlimited drops the controller's limit; the global floor is dropped by the declaration itself.
    if (this.options.config !== false && (route?.Middlewares ?? []).some(isDeclaredOff)) return false;
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
    check(_is_number(_integer(), _between(16, 128)), prefix, 'http.throttle.ipv6Prefix', option);
    this.prefix = prefix as number;

    this.route = `rate:${String(route.InternalType).toUpperCase()} ${path}:${settings.limit}/${settings.windowSeconds}`;
  }

  public async onBefore(ctx: IMiddlewareContext): Promise<Response | void> {
    const settings = this.settings;
    if (settings === false) return;
    if (settings === undefined || this.route === '') {
      throw new InvalidOperation(`${this.constructor.name} was not registered on its route: a subclass overriding onRegister must call super.onRegister`);
    }

    const { res } = ctx;
    const { answer } = this.options;
    const headers = this.sendsHeaders(settings);

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
    if (!answer) return headers ? rateLimitAnswer(res, settings.limit, hit) : quietRateLimitAnswer(settings.limit, hit);
    if (headers) setRateLimitHeaders(res, settings.limit, hit);
    if (hit.count <= settings.limit) return;

    const retryAfter = retryAfterSeconds(hit);
    if (headers) res.set('Retry-After', String(retryAfter));
    return answer(retryAfter);
  }

  /**
   * What the limit adds to the route's API document: its throttled answer (a custom `answer` only when marked with
   * `documentedAnswer`) and, when it sends them, the `X-RateLimit-*` headers and its effective numbers. Several
   * limits on one route document apart; a document generator decides which wins.
   */
  public override documentation(_route: IRoute): IRouteMiddlewareDoc | undefined {
    const settings = this.settings;
    if (!settings) return undefined;

    const headers = this.sendsHeaders(settings);
    const closed = settings.limit === 0;
    const responses = this.options.answer ? customAnswerDoc(this.options.answer, closed, headers) : { '429': tooManyRequestsDoc(closed, headers) };
    if (!headers) return responses ? { responses } : {};
    // A custom key counts on its own value first, so `by` would misstate what is counted.
    const counted = this.options.key ? {} : { by: settings.by };
    return {
      ...(responses ? { responses } : {}),
      // a closed route never lets a request through to a success answer
      ...(closed ? {} : { headers: rateLimitHeadersDoc() }),
      extensions: { 'x-rate-limit': [{ limit: settings.limit, windowSeconds: settings.windowSeconds, ...counted }] },
    };
  }

  private sendsHeaders(settings: RateLimitDefault): boolean {
    return settings.headers ?? this.options.headers ?? false;
  }

  private current(): Partial<IRateLimitSettings> {
    if (this.settings) return this.settings;
    return { ...this.options.default, ...defined({ limit: this.options.limit, windowSeconds: this.options.windowSeconds, by: this.options.by }) };
  }

  private resolveSettings(): RateLimitDefault | false {
    if (this.settings !== undefined) return this.settings;

    this.checkOptions();
    const { config, limit, windowSeconds, by } = this.options;
    if (config === false) {
      const others = Object.keys(this.options).filter((k) => k !== 'config');
      if (others.length > 0) throw new InvalidArgument(`@RateLimit({ config: false }) declares no limit and takes no other option, got ${others.join(', ')}`);
      return (this.settings = false);
    }
    const inline = defined({ limit, windowSeconds, by });
    if (config === undefined) {
      return (this.settings = checkSettings({ ...this.options.default, ...inline } as IRateLimitSettings, '@RateLimit ', argument));
    }

    if (Object.keys(inline).length > 0) throw new InvalidArgument(`@RateLimit({ config: '${config}' }) takes its settings from config and default, not inline ${Object.keys(inline).join(', ')}`);
    const fallback = this.options.default;
    check(_is_object(), fallback, `@RateLimit({ config: '${config}' }) default`, argument);
    const base = checkSettings(fallback as IRateLimitSettings, '@RateLimit default.', argument);

    const configured = this.Configuration.get<unknown>(config);
    if (configured === false) return (this.settings = false);
    if (configured === undefined || configured === null) return (this.settings = base);

    check(_is_object(), configured, config, option);
    const accepted = settingsKeys(this.options);
    const unknown = Object.keys(configured).filter((k) => !accepted.includes(k));
    if (unknown.length > 0) throw new InvalidOption(`${config} has unknown keys ${unknown.join(', ')}; allowed: ${accepted.join(', ')}`);

    return (this.settings = checkSettings({ ...fallback, ...defined(configured) } as IRateLimitSettings, `${config}.`, option));
  }

  /** The options can come from JSON (`http.routes.middlewares`), where a typo or a string "false" would be ignored. */
  private checkOptions(): void {
    const { config, answer, key, headers } = this.options;
    const unknown = Object.keys(this.options).filter((k) => !OPTION_KEYS.includes(k));
    if (unknown.length > 0) throw new InvalidArgument(`@RateLimit has unknown options ${unknown.join(', ')}; allowed: ${OPTION_KEYS.join(', ')}`);
    check(optional(_or(_one_of([false]), _is_string(_non_empty()))), config, '@RateLimit config', argument);
    check(isFunction('@RateLimit answer'), answer, '@RateLimit answer', argument);
    check(isFunction('@RateLimit key'), key, '@RateLimit key', argument);
    check(HEADERS, headers, '@RateLimit headers', argument);
    const fallback = this.options.default;
    if (typeof fallback === 'object' && fallback !== null) {
      const accepted = settingsKeys(this.options);
      const unknownDefault = Object.keys(fallback).filter((k) => !accepted.includes(k));
      if (unknownDefault.length > 0) throw new InvalidArgument(`@RateLimit default has unknown keys ${unknownDefault.join(', ')}; allowed: ${accepted.join(', ')}`);
      // Here, not in checkSettings: without `config` it would label it as the top-level `@RateLimit headers`.
      check(HEADERS, fallback.headers, '@RateLimit default.headers', argument);
    }
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
 * per authenticated principal. Over the limit it answers 429 with `Retry-After`, the body `ThrottleMiddleware` sends.
 * The `X-RateLimit-*` headers are opt-in: with `headers: true`, every counted request gets them.
 *
 * The options form reads the numbers from configuration (`false` there takes the limit off the route), and can
 * replace the throttled answer, send the headers or count on a key of its own.
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
