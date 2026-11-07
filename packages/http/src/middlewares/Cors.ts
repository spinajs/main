import * as express from 'express';
import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';

import { FIELD_NAME_PATTERN } from '../headers.js';
import { HTTP_STATUS_CODE, Response, ServerMiddleware } from '../interfaces.js';
import type { IMiddlewareContext } from '../interfaces.js';
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

// Lets every request skip the route lookup while no class declared @Cors.
let routePoliciesDeclared = false;

/**
 * The CORS policy of the route, or on a class of every route of the controller (a route's own wins). Its origins
 * replace `http.cors.origins` there, also when `http.cors` is not set; `exposedHeaders` and `allowedHeaders` still
 * come from `http.cors`. A preflight gets the policy of the route its `Access-Control-Request-Method` names. Throws
 * `InvalidOption` for an entry that is not an origin, or a `maxAge` that is not a whole number of seconds.
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
    routePoliciesDeclared = true;
  };
}

function routeCorsPolicy(controller: object, member: string | symbol): ICorsPolicy | undefined {
  return (Reflect.getMetadata(CORS_ROUTE_SYMBOL, controller, member) ?? Reflect.getMetadata(CORS_ROUTE_SYMBOL, controller)) as ICorsPolicy | undefined;
}

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
 *   http.cors                 absent or falsy: CORS headers on `@Cors` routes only
 *   http.cors.origins         (string[]) origins as scheme://host[:port], compared exactly as URL origins and
 *                             echoed with credentials and `Vary: Origin`. Empty, null or absent: no CORS headers
 *                             outside `@Cors` routes, so browsers allow only same-origin requests (2.x reflected every
 *                             origin here). '*' answers `Access-Control-Allow-Origin: *` without credentials to an
 *                             origin not listed explicitly; a listed origin next to '*' still gets its echo with
 *                             credentials. An entry that is not an origin fails the boot.
 *   http.cors.exposedHeaders  (string[]) for allowed origins
 *   http.cors.allowedHeaders  (string[]) for allowed preflights; without it the requested headers are allowed.
 *                             `Forwarded` and `X-Forwarded-*` are never allowed.
 *
 * A request from an origin that is not allowed proceeds without CORS headers; the browser then refuses to share
 * the response. An allowed preflight is answered 204 here, through the reply pipeline.
 */
@Injectable(ServerMiddleware)
export class CorsMiddleware extends ServerMiddleware {
  @Config('http.cors')
  protected Cors: { origins?: readonly string[] | null; exposedHeaders?: unknown; allowedHeaders?: unknown } | boolean | null | undefined;

  @Logger('http')
  protected Log!: Log;

  /** Finds the route a preflight asks about. */
  @Autoinject(RouteIndex)
  protected Routes?: RouteIndex;

  private policy?: ICorsPolicy | null;
  private headers?: ICorsHeaders;

  constructor() {
    super();
    // early, so a preflight is answered before any business middleware runs
    this.Order = -1;
  }

  public async resolve(): Promise<void> {
    this.corsPolicy();
    await super.resolve();
  }

  /** Always on, so `@Cors` routes answer without `http.cors.origins`; a bad `http.cors` entry fails the mount. */
  public isEnabled(): boolean {
    this.corsPolicy();
    this.corsHeaders();
    return true;
  }

  /**
   * What `origin` (the request's Origin header, as sent) gets on a route without `@Cors`, or undefined for no CORS
   * headers. By default a listed origin is echoed with credentials, and any other gets '*' when `http.cors.origins`
   * holds '*'. Override it to allow origins by a rule.
   */
  protected allowance(origin: string): CorsAllowance | undefined {
    return allowanceOf(this.corsPolicy(), origin);
  }

  public onBefore(ctx: IMiddlewareContext): Response | undefined {
    const { req, res } = ctx;
    const preflight = req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
    const routed = routePoliciesDeclared ? this.routePolicy(ctx, preflight) : undefined;
    const policy = routed ?? this.corsPolicy() ?? NO_ORIGINS;
    // an overridden allowance() may echo the origin, so the answer depends on it even with only '*' configured
    if (policy.listed.size > 0 || (!routed && this.allowance !== CorsMiddleware.prototype.allowance)) res.vary('Origin');

    const origin = req.headers.origin;
    const allowance = typeof origin !== 'string' ? undefined : routed ? allowanceOf(routed, origin) : this.allowance(origin);
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

  /** The `@Cors` policy of the route the request goes to; for a preflight, the route of the method it asks about. */
  private routePolicy(ctx: IMiddlewareContext, preflight: boolean): ICorsPolicy | undefined {
    const target = preflight ? this.Routes?.match(String(ctx.req.headers['access-control-request-method']), ctx.req.path) : ctx;
    return target?.route && target.controller ? routeCorsPolicy(target.controller, target.route.Method) : undefined;
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
