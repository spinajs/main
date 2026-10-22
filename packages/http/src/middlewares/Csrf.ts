import Express from 'express';
import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';

import { HTTP_STATUS_CODE, ServerMiddleware, Request as sRequest } from '../interfaces.js';
import { BaseController } from '../base-controller.js';
import { isCsrfExempt } from '../decorators.js';
import { buildRoutePath } from '../route-builder.js';
import { parseOrigin } from './Cors.js';
import { requestOrigin, requestProxyTrust } from './RealIp.js';
import { SameOriginGuard, checkSameOrigin, parseAllowedOrigins } from './SameOrigin.js';
import type { OriginDecision, OriginRefusal, SameOriginOptions } from './SameOrigin.js';

/** `http.csrf`. */
export interface ICsrfConfiguration {
  /** Only `false` switches the guard off. */
  enabled?: boolean;
  /** Origins accepted besides the app's own. */
  allowedOrigins?: readonly string[] | null;
  /** Route paths the guard never checks, after `http.controllers.route.prefix`, matched as the router matches routes. */
  exempt?: readonly string[] | null;
  /** Cookie names browsers attach on their own (sessions): a request carrying one is checked even without Origin and Sec-Fetch-Site. */
  ambientCookies?: readonly string[] | null;
}

export const CSRF_REFUSED_BODY = Object.freeze({ error: Object.freeze({ code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' }) });

const EXEMPT_KEY = 'http.csrf.exempt';
const MALFORMED: OriginDecision = Object.freeze({ allowed: false, reason: 'malformed-origin' });

function carriesCookie(header: string | undefined, names: readonly string[]): boolean {
  if (names.length === 0 || !header) return false;
  return header.split(';').some((pair) => names.includes(pair.split('=')[0].trim()));
}

/** The parts of an Express router layer the matcher uses; internal to Express 4 and 5 alike. */
interface RouteLayer {
  match(path: string): boolean;
  route?: { _handlesMethod(method: string): boolean };
}

const NOOP: Express.RequestHandler = (_req, _res, next) => next();

/**
 * The exempt config entries and `@CsrfExempt()` routes, compiled by an Express router so a path is exempt exactly when
 * the router would serve it (params, case, trailing slash). Matched synchronously against the layers, since a refusal
 * must not wait for the router's deferred dispatch. Controllers can be added after the server started, so the layers
 * are rebuilt whenever the resolved controllers change.
 */
class ExemptRoutes {
  private layers: readonly RouteLayer[] = [];
  private builtFor: readonly BaseController[] | undefined;

  constructor(
    private readonly paths: readonly string[],
    private readonly prefix: string | undefined,
    private readonly controllers: () => readonly BaseController[],
  ) {
    // Compiled here so a bad entry fails the boot, not the first refused request.
    this.build([]);
    this.builtFor = undefined;
  }

  public has(req: sRequest): boolean {
    const current = this.controllers();
    if (this.builtFor === undefined || current.length !== this.builtFor.length || current.some((c, i) => c !== this.builtFor![i])) this.build(current);
    const path = req.path;
    if (typeof path !== 'string') return false;
    try {
      return this.layers.some((layer) => layer.match(path) && layer.route?._handlesMethod(req.method) === true);
    } catch {
      // A malformed percent-encoding in a parameter: the router would answer 400, so nothing is exempt.
      return false;
    }
  }

  private build(controllers: readonly BaseController[]): void {
    const router = Express.Router();
    const methods = router as unknown as Record<string, ((path: string, handler: Express.RequestHandler) => void) | undefined>;

    const prefix = (this.prefix ?? '').replace(/^\/+|\/+$/g, '');
    for (const entry of this.paths) {
      if (typeof entry !== 'string' || !entry.startsWith('/')) throw new InvalidOption(`${EXEMPT_KEY} entry ${JSON.stringify(entry)} is not an absolute path`);
      try {
        router.all(prefix === '' ? entry : `/${prefix}${entry}`, NOOP);
      } catch (err) {
        throw new InvalidOption(`${EXEMPT_KEY} entry ${JSON.stringify(entry)} is not a route path: ${(err as Error).message}`);
      }
    }

    for (const controller of controllers) {
      if (!controller.Descriptor) continue;
      for (const [member, route] of controller.Descriptor.Routes) {
        if (!isCsrfExempt(controller, member)) continue;
        const path = buildRoutePath(controller.BasePath, route, this.prefix);
        const method = methods[String(route.InternalType).toLowerCase()];
        if (typeof method === 'function') method.call(router, path, NOOP);
        else router.all(path, NOOP);
      }
    }

    this.layers = (router as unknown as { stack: RouteLayer[] }).stack;
    this.builtFor = controllers;
  }
}

/**
 * Order 4. Default-deny CSRF protection by Origin and Fetch Metadata, without tokens. An unsafe request (any method but
 * GET, HEAD and OPTIONS) is checked when it carries Origin or Sec-Fetch-Site (it came from a browser) or one of the
 * ambient cookies; it then passes only with the app's own origin or one in `http.csrf.allowedOrigins`, or, without an
 * Origin, `Sec-Fetch-Site: same-origin`. Else 403 {@link CSRF_REFUSED_BODY}. A request with none of these (a server, a
 * CLI) passes. Routes marked `@CsrfExempt()` and paths in `http.csrf.exempt` are never refused.
 *
 * A registered subclass (authn-http's guard, which adds the session cookie) replaces this one.
 */
@Injectable(ServerMiddleware)
export class CsrfGuard extends SameOriginGuard {
  @Config('http.csrf.enabled')
  protected Enabled: unknown;

  @Config('http.csrf.allowedOrigins')
  protected AllowedOrigins: readonly string[] | null;

  @Config('http.csrf.exempt')
  protected Exempt: readonly string[] | null;

  @Config('http.csrf.ambientCookies')
  protected AmbientCookies: readonly string[] | null;

  @Config('http.controllers.route.prefix')
  protected RoutePrefix: string | undefined;

  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
    // After http.throttle (3), before authentication reads any credential.
    this.Order = 4;
  }

  protected enabled(): boolean {
    return this.Enabled !== false;
  }

  protected allowedOrigins(): ReadonlySet<string> {
    return parseAllowedOrigins(this.AllowedOrigins, 'http.csrf.allowedOrigins');
  }

  protected ambientCookies(): readonly string[] {
    return this.AmbientCookies ?? [];
  }

  protected exemptPaths(): readonly string[] {
    return this.Exempt ?? [];
  }

  /** The controllers whose `@CsrfExempt()` routes count; every resolved BaseController by default. */
  protected controllers(): readonly BaseController[] {
    return (DI.getRegisteredTypes(BaseController) ?? [])
      .filter((type) => DI.has(type))
      .map((type) => DI.get(type))
      .filter((c): c is BaseController => c instanceof BaseController);
  }

  /** The app's own origin, with the proxy trust RealIp resolved. */
  protected ownOrigin(req: sRequest): string | undefined {
    return parseOrigin(requestOrigin(req, requestProxyTrust(req)));
  }

  protected refuse(reason: OriginRefusal, req: sRequest, res: Express.Response, _next: Express.NextFunction): void {
    this.Log?.debug({ reason, method: req.method, path: req.path }, 'CsrfGuard refused ${method} ${path}: ${reason}');
    res.status(HTTP_STATUS_CODE.FORBIDDEN).json(CSRF_REFUSED_BODY);
  }

  private superseded(): boolean {
    const own = this.constructor;
    return (DI.getRegisteredTypes(ServerMiddleware) ?? []).some((t) => t !== own && typeof t === 'function' && t.prototype instanceof own);
  }

  /** The decision for an unsafe request that is checked; undefined when the request is not checked at all. */
  protected decide(req: sRequest, cookies: readonly string[], options: SameOriginOptions): OriginDecision | undefined {
    const origin = req.headers.origin;
    if (origin === undefined && req.headers['sec-fetch-site'] === undefined && !carriesCookie(req.headers.cookie, cookies)) return undefined;
    // Browsers send the serialized origin; any other spelling (case, a trailing slash) did not come from one.
    if (origin !== undefined && parseOrigin(origin) !== origin) return MALFORMED;
    return checkSameOrigin(req.headers, origin === undefined ? undefined : this.ownOrigin(req), options);
  }

  public before(): ((req: sRequest, res: Express.Response, next: Express.NextFunction) => void) | null {
    if (this.superseded()) return null;

    // Built before the enabled check, so a bad setting fails the boot even while the guard is off.
    const options: SameOriginOptions = { allowedOrigins: this.allowedOrigins(), missingOrigin: 'same-origin-fetch' };
    const cookies = this.ambientCookies();
    const exempt = new ExemptRoutes(this.exemptPaths(), this.RoutePrefix, () => this.controllers());
    if (!this.enabled()) return null;

    return (req: sRequest, res: Express.Response, next: Express.NextFunction) => {
      if (!this.appliesTo(req)) return next();
      const decision = this.decide(req, cookies, options);
      if (decision === undefined || decision.allowed) return next();
      if (exempt.has(req)) return next();
      this.refuse(decision.reason, req, res, next);
    };
  }
}
