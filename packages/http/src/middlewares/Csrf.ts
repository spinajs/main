import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';

import { HTTP_STATUS_CODE, ServerMiddleware, Request as sRequest } from '../interfaces.js';
import type { IMiddlewareContext, Response } from '../interfaces.js';
import { RawJsonResponse } from '../response-methods/rawJson.js';
import { isCsrfExempt } from '../decorators.js';
import { RoutePathMatcher } from '../route-index.js';
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

/** The `http.csrf.exempt` entries behind the route prefix, matched for any method as the router matches routes. */
function exemptPathMatcher(paths: readonly string[], routePrefix: string | undefined): RoutePathMatcher<true> {
  const matcher = new RoutePathMatcher<true>();
  const prefix = (routePrefix ?? '').replace(/^\/+|\/+$/g, '');
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry.startsWith('/')) throw new InvalidOption(`${EXEMPT_KEY} entry ${JSON.stringify(entry)} is not an absolute path`);
    try {
      matcher.add(prefix === '' ? entry : `/${prefix}${entry}`, true);
    } catch (err) {
      throw new InvalidOption(`${EXEMPT_KEY} entry ${JSON.stringify(entry)} is not a route path: ${(err as Error).message}`);
    }
  }
  return matcher;
}

/**
 * Order 4. Default-deny CSRF protection by Origin and Fetch Metadata, without tokens. An unsafe request (any method but
 * GET, HEAD and OPTIONS) is checked when it carries Origin or Sec-Fetch-Site (it came from a browser) or one of the
 * ambient cookies; it then passes only with the app's own origin or one in `http.csrf.allowedOrigins`, or, without an
 * Origin, `Sec-Fetch-Site: same-origin`. Else 403 {@link CSRF_REFUSED_BODY}. A request with none of these (a server, a
 * CLI) passes. Routes marked `@CsrfExempt()` and paths in `http.csrf.exempt` are never refused; the route is the one
 * the RouteIndex matches before routing.
 *
 * A registered subclass (authn-http's guard, which adds the session cookie) replaces this one: `isEnabled()` is then
 * false.
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

  private csrf?: { readonly options: SameOriginOptions; readonly cookies: readonly string[]; readonly exempt: RoutePathMatcher<true> };

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

  /** The app's own origin, with the proxy trust RealIp resolved. */
  protected ownOrigin(req: sRequest): string | undefined {
    return parseOrigin(requestOrigin(req, requestProxyTrust(req)));
  }

  /** The answer to a refused request: 403 with {@link CSRF_REFUSED_BODY} by default. */
  protected refuse(reason: OriginRefusal, req: sRequest): Response {
    this.Log?.debug({ reason, method: req.method, path: req.path }, 'CsrfGuard refused ${method} ${path}: ${reason}');
    return new RawJsonResponse(HTTP_STATUS_CODE.FORBIDDEN, CSRF_REFUSED_BODY);
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

  /** False when a registered subclass replaces this guard, or with `http.csrf.enabled: false`. */
  public isEnabled(): boolean {
    if (this.superseded()) return false;
    // Built before the enabled check, so a bad setting fails the boot even while the guard is off.
    this.csrfSettings();
    return this.enabled();
  }

  /** Whether the request is never refused: its route is `@CsrfExempt()` or its path is in `http.csrf.exempt`. */
  protected isExempt(ctx: IMiddlewareContext, paths: RoutePathMatcher<true>): boolean {
    const { route, controller } = ctx;
    if (route && controller && isCsrfExempt(controller, route.Method)) return true;
    return typeof ctx.req.path === 'string' && paths.match(ctx.req.method, ctx.req.path) === true;
  }

  public onBefore(ctx: IMiddlewareContext): Response | undefined {
    const request = ctx.req as sRequest;
    if (!this.appliesTo(request)) return undefined;
    const { options, cookies, exempt } = this.csrfSettings();
    const decision = this.decide(request, cookies, options);
    if (decision === undefined || decision.allowed || this.isExempt(ctx, exempt)) return undefined;
    return this.refuse(decision.reason, request);
  }

  private csrfSettings() {
    return (this.csrf ??= {
      options: { allowedOrigins: this.allowedOrigins(), missingOrigin: 'same-origin-fetch' },
      cookies: this.ambientCookies(),
      exempt: exemptPathMatcher(this.exemptPaths(), this.RoutePrefix),
    });
  }
}
