import * as express from 'express';
import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';

import { FIELD_NAME_PATTERN } from '../headers.js';
import { HTTP_STATUS_CODE, Response, ServerMiddleware } from '../interfaces.js';
import type { IController, IMiddlewareContext, IReplyContext, IRoute } from '../interfaces.js';
import { RouteIndex } from '../route-index.js';

const ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

/**
 * `value` as a serialized origin (scheme://host[:port]; case, default port and a trailing slash normalised), or
 * undefined when it is anything else.
 */
export function parseOrigin(value: unknown): string | undefined {
  // A value with a path, query, credentials or wildcard host would be cut down to an origin it never named.
  if (typeof value !== 'string' || /[*@\\]/.test(value) || !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(value)) return undefined;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

const headerList = (value: unknown): string | undefined => {
  const joined = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return joined === '' ? undefined : joined;
};

// A page on a listed origin that could send these would choose what the app believes a trusted proxy said:
// the client address and the app's own origin (authn-http's CSRF guard compares Origin with it).
const PROXY_HEADER = /^(forwarded|x-forwarded-[a-z0-9-]*)$/i;

const withoutProxyHeaders = (list: string | undefined, keep: (name: string) => boolean = () => true): string | undefined => {
  const kept = (list ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '' && !PROXY_HEADER.test(h) && keep(h))
    .join(',');
  return kept === '' ? undefined : kept;
};

// RFC 9110 field-name: anything else in Access-Control-Request-Headers names no header and is not echoed back.
const isFieldName = (name: string): boolean => FIELD_NAME_PATTERN.test(name);

/** What a request's Origin gets: `Access-Control-Allow-Origin: <allowOrigin>`, and credentials when `credentials`. */
export interface CorsAllowance {
  readonly allowOrigin: string;
  readonly credentials: boolean;
}

/** `@Cors(...)`: the CORS policy of a route, replacing `http.cors.origins` for it. */
export interface ICorsRouteOptions {
  /** Origins as scheme://host[:port], or '*'. Empty: the route answers no origin. */
  readonly origins: readonly string[];
  /** Whether a listed origin gets `Access-Control-Allow-Credentials: true`; true by default. '*' never does. */
  readonly credentials?: boolean;
  /** Seconds a browser may cache the route's preflight answer (`Access-Control-Max-Age`). */
  readonly maxAge?: number;
}

interface ICorsPolicy {
  readonly any: boolean;
  readonly listed: ReadonlySet<string>;
  readonly credentials: boolean;
  readonly maxAge?: string;
}

interface ICorsHeaders {
  readonly exposed?: string;
  readonly allowed?: string;
}

const NO_ORIGINS: ICorsPolicy = Object.freeze({ any: false, listed: new Set<string>(), credentials: true });

function originPolicy(origins: readonly unknown[], invalid: (entry: unknown) => Error, credentials = true, maxAge?: number): ICorsPolicy {
  const listed = new Set<string>();
  for (const entry of origins.filter((e) => e !== '*')) {
    const origin = parseOrigin(entry);
    if (origin === undefined) throw invalid(entry);
    listed.add(origin);
  }
  return { any: origins.includes('*'), listed, credentials, maxAge: maxAge === undefined ? undefined : String(maxAge) };
}

function allowanceOf(policy: ICorsPolicy | null, origin: string): CorsAllowance | undefined {
  // Browsers send the serialized origin, the form the listed entries were normalised to.
  if (policy?.listed.has(origin)) return { allowOrigin: origin, credentials: policy.credentials };
  return policy?.any ? { allowOrigin: '*', credentials: false } : undefined;
}

const CORS_ROUTE_SYMBOL = Symbol.for('spinajs:http:cors');

/**
 * The CORS policy of the route, or on a class of every route of the controller (a route's own wins). Its origins
 * replace `http.cors.origins` there, also when `http.cors` is not set, so it may allow more than `http.cors`;
 * `exposedHeaders` and `allowedHeaders` still come from `http.cors`. An overridden `CorsMiddleware.allowance()` clamps
 * it. Throws `InvalidOption` for an entry that is not an origin, or a `maxAge` that is not a whole number of seconds.
 */
export function Cors(options: ICorsRouteOptions) {
  const { origins, credentials, maxAge } = options ?? ({} as Partial<ICorsRouteOptions>);
  if (!Array.isArray(origins)) throw new InvalidOption(`@Cors origins must be an array of origins (scheme://host[:port]) or '*'`);
  if (maxAge !== undefined && !(Number.isInteger(maxAge) && maxAge >= 0)) throw new InvalidOption(`@Cors maxAge ${JSON.stringify(maxAge)} is not a whole number of seconds`);
  const policy = originPolicy(origins, (entry) => new InvalidOption(`@Cors origins entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port]) or '*'`), credentials !== false, maxAge);

  return (target: object, propertyKey?: string | symbol, _descriptor?: PropertyDescriptor) => {
    if (propertyKey === undefined) {
      Reflect.defineMetadata(CORS_ROUTE_SYMBOL, policy, (target as { prototype: object }).prototype);
    } else {
      Reflect.defineMetadata(CORS_ROUTE_SYMBOL, policy, target, propertyKey);
    }
  };
}

function routeCorsPolicy(match: { readonly route?: IRoute; readonly controller?: IController }): ICorsPolicy | undefined {
  const { route, controller } = match;
  if (!route || !controller) return undefined;
  return (Reflect.getMetadata(CORS_ROUTE_SYMBOL, controller, route.Method) ?? Reflect.getMetadata(CORS_ROUTE_SYMBOL, controller)) as ICorsPolicy | undefined;
}

function samePolicy(a: ICorsPolicy | undefined, b: ICorsPolicy | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.any === b.any && a.credentials === b.credentials && a.maxAge === b.maxAge && a.listed.size === b.listed.size && [...a.listed].every((o) => b.listed.has(o));
}

const isPreflight = (req: express.Request) => req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;

const ALLOWANCE_HEADERS = ['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Expose-Headers'];

/** The answer to an allowed preflight: 204 without a body, with the CORS headers already set on `res`. */
class PreflightResponse extends Response<null> {
  protected _errorCode = HTTP_STATUS_CODE.NO_CONTENT;
  protected _template = '';

  constructor() {
    super(null);
  }

  public execute(_req: express.Request, res: express.Response): Promise<void> {
    res.statusCode = this.statusCode;
    for (const header of this.headers) {
      res.setHeader(header.Name, header.Value);
    }
    res.setHeader('Content-Length', '0');
    res.end();
    return Promise.resolve();
  }
}

/**
 * CORS by rule A31: only listed origins get CORS headers. A route marked {@link Cors} uses its own origins instead.
 *
 * Config:
 *   http.cors                     absent or falsy: CORS headers on `@Cors` routes only
 *   http.cors.origins             (string[]) origins as scheme://host[:port], compared exactly as URL origins and
 *                                 echoed with credentials and `Vary: Origin`. Empty, null or absent: no CORS headers
 *                                 outside `@Cors` routes, so browsers allow only same-origin requests (2.x reflected
 *                                 every origin here). '*' answers `Access-Control-Allow-Origin: *` without credentials
 *                                 to an origin not listed explicitly; a listed origin next to '*' still gets its echo
 *                                 with credentials. An entry that is not an origin fails the boot.
 *   http.cors.exposedHeaders      (string[]) for allowed origins
 *   http.cors.allowedHeaders      (string[]) for allowed preflights; without it the requested headers are allowed.
 *                                 `Forwarded` and `X-Forwarded-*` are never allowed.
 *   http.cors.allowRoutePolicies  false: `@Cors` is ignored. Default true.
 *
 * A request from an origin that is not allowed proceeds without CORS headers; the browser then refuses to share
 * the response. An allowed preflight is answered 204 here, through the reply pipeline.
 *
 * Route policies: a preflight gets the `@Cors` policy only when every mounted route serving the method it asks about
 * on that path has the same one (the lookup runs before routing); any other request gets it in `onAfter`, from the
 * route the router matched, so static files and replies written to `res` keep the global policy.
 */
@Injectable(ServerMiddleware)
export class CorsMiddleware extends ServerMiddleware {
  @Config('http.cors')
  protected Cors: { origins?: readonly string[] | null; exposedHeaders?: unknown; allowedHeaders?: unknown } | boolean | null | undefined;

  @Config('http.cors.allowRoutePolicies', { defaultValue: true })
  protected AllowRoutePolicies: unknown;

  @Logger('http')
  protected Log!: Log;

  /** The routes a preflight asks about, and whether any of them has a `@Cors` policy. */
  @Autoinject(RouteIndex)
  protected Routes?: RouteIndex;

  @Autoinject(Container)
  protected Container?: IContainer;

  private policy?: ICorsPolicy | null;
  private headers?: ICorsHeaders;
  private policiesVersion?: number;
  private routePolicies = false;

  constructor() {
    super();
    // early, so a preflight is answered before any business middleware runs
    this.Order = -1;
  }

  public async resolve(): Promise<void> {
    this.corsPolicy();
    // logs the @Cors routes once the controllers are mounted
    this.Container?.once('http.server.listening', () => this.routePoliciesMounted());
    await super.resolve();
  }

  /** Always on, so `@Cors` routes answer without `http.cors.origins`; a bad `http.cors` entry fails the mount. */
  public isEnabled(): boolean {
    this.corsPolicy();
    this.corsHeaders();
    return true;
  }

  /**
   * What `origin` (the request's Origin header, as sent) gets, or undefined for no CORS headers. By default a listed
   * origin is echoed with credentials, and any other gets '*' when `http.cors.origins` holds '*'. Override it to allow
   * origins by a rule. An override also clamps `@Cors` routes: their origin is allowed only when it allows it too, and
   * with credentials only when both give them.
   */
  protected allowance(origin: string): CorsAllowance | undefined {
    return allowanceOf(this.corsPolicy(), origin);
  }

  public onBefore({ req, res }: IMiddlewareContext): Response | undefined {
    const preflight = isPreflight(req);
    const routed = preflight && this.routePoliciesMounted() ? this.preflightPolicy(req) : undefined;
    const policy = routed ?? this.corsPolicy() ?? NO_ORIGINS;
    // an overridden allowance() may echo the origin, so the answer depends on it even with only '*' configured
    if (policy.listed.size > 0 || this.allowanceOverridden()) res.vary('Origin');

    const origin = req.headers.origin;
    const allowance = typeof origin !== 'string' ? undefined : routed ? this.routeAllowance(routed, origin) : this.allowance(origin);
    if (!allowance) return undefined;

    res.setHeader('Access-Control-Allow-Origin', allowance.allowOrigin);
    if (allowance.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');

    const headers = this.corsHeaders();
    if (preflight) {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      const requested = req.headers['access-control-request-headers'];
      if (headers.allowed) {
        res.setHeader('Access-Control-Allow-Headers', headers.allowed);
      } else if (requested) {
        res.vary('Access-Control-Request-Headers');
        const echoed = withoutProxyHeaders(requested, isFieldName);
        if (echoed) res.setHeader('Access-Control-Allow-Headers', echoed);
      }
      if (policy.maxAge !== undefined) res.setHeader('Access-Control-Max-Age', policy.maxAge);
      return new PreflightResponse();
    }

    if (headers.exposed) res.setHeader('Access-Control-Expose-Headers', headers.exposed);
    return undefined;
  }

  /** A framework reply of a `@Cors` route: its policy replaces the global answer `onBefore` gave. */
  public onAfter(ctx: IReplyContext): void {
    if (isPreflight(ctx.req) || !this.routePoliciesMounted()) return;
    const policy = routeCorsPolicy(ctx);
    if (!policy) return;

    const { req, res } = ctx;
    for (const name of ALLOWANCE_HEADERS) res.removeHeader(name);
    if (policy.listed.size > 0) res.vary('Origin');

    const origin = req.headers.origin;
    const allowance = typeof origin === 'string' ? this.routeAllowance(policy, origin) : undefined;
    if (!allowance) return;

    res.setHeader('Access-Control-Allow-Origin', allowance.allowOrigin);
    if (allowance.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    const { exposed } = this.corsHeaders();
    if (exposed) res.setHeader('Access-Control-Expose-Headers', exposed);
  }

  private allowanceOverridden(): boolean {
    return this.allowance !== CorsMiddleware.prototype.allowance;
  }

  private routeAllowance(policy: ICorsPolicy, origin: string): CorsAllowance | undefined {
    const proposed = allowanceOf(policy, origin);
    if (!proposed || !this.allowanceOverridden()) return proposed;
    const clamp = this.allowance(origin);
    return clamp ? { allowOrigin: proposed.allowOrigin, credentials: proposed.credentials && clamp.credentials } : undefined;
  }

  /** The policy every mounted route serving the asked method on this path shares; undefined (the global one) otherwise. */
  private preflightPolicy(req: express.Request): ICorsPolicy | undefined {
    const routes = this.Routes?.matchAll(String(req.headers['access-control-request-method']), req.path) ?? [];
    const policies = routes.map(routeCorsPolicy);
    return policies.length > 0 && policies.every((p) => samePolicy(p, policies[0])) ? policies[0] : undefined;
  }

  /** Whether a mounted route has a `@Cors` policy, worked out again (and logged) only when the mounted routes changed. */
  private routePoliciesMounted(): boolean {
    const routes = this.Routes;
    if (!routes || this.AllowRoutePolicies === false) return false;
    if (this.policiesVersion === routes.version) return this.routePolicies;

    this.policiesVersion = routes.version;
    const withPolicy = routes.all().filter((m) => routeCorsPolicy(m) !== undefined);
    this.routePolicies = withPolicy.length > 0;
    for (const m of withPolicy) {
      const policy = routeCorsPolicy(m)!;
      const origins = [...(policy.any ? ['*'] : []), ...policy.listed].join(', ') || '(none)';
      this.Log?.info({ route: m.path, origins, credentials: policy.credentials }, 'CORS policy of ${route}: origins ${origins}, credentials ${credentials}');
    }
    return this.routePolicies;
  }

  private corsConfig() {
    // true passes the schema (no CORS, as false does) and has no origins to read.
    return typeof this.Cors === 'object' ? this.Cors : null;
  }

  private corsHeaders(): ICorsHeaders {
    const cfg = this.corsConfig();
    return (this.headers ??= { exposed: headerList(cfg?.exposedHeaders), allowed: withoutProxyHeaders(headerList(cfg?.allowedHeaders)) });
  }

  private corsPolicy(): ICorsPolicy | null {
    if (this.policy !== undefined) return this.policy;

    const policy = originPolicy(this.corsConfig()?.origins ?? [], (entry) => new InvalidOption(`http.cors.origins entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port]) or '*'`));
    if (!policy.any && policy.listed.size === 0) {
      this.Log.warn(`http.cors.origins is not set or empty: only routes marked @Cors send CORS headers, so browsers allow only same-origin requests elsewhere. List the origins your browser clients use in http.cors.origins.`);
      this.policy = null;
    } else {
      this.policy = policy;
    }
    return this.policy;
  }
}
