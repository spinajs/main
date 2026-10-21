import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import '@spinajs/authn-session/register-schema';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_STATUS_CODE, ServerMiddleware, parseOrigin, requestOrigin } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import { SESSION_COOKIE_BASE_NAME } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { Log, Logger } from '@spinajs/log';
import type * as express from 'express';

import { proxyTrustOf } from './client-ip.js';
import { CSRF_REFUSED_EVENT } from './csrf-log.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_ORIGINS_KEY = 'authn.http.csrf.allowedOrigins';
const UNAUTHENTICATED_ROUTES_KEY = 'authn.http.csrf.unauthenticatedRoutes';
const REFUSED = Object.freeze({ error: Object.freeze({ code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' }) });

/**
 * The app's own origin for this request: scheme from the connection and host from Host, or X-Forwarded-Proto and
 * -Host from a trusted proxy only. undefined when they do not make an origin (no Host, or a Host with a path).
 */
export function ownOrigin(req: Parameters<typeof requestOrigin>[0], trust: ProxyTrust): string | undefined {
  return parseOrigin(requestOrigin(req, trust));
}

/** The schema judges the shape of each entry; `parseOrigin` normalises it and still refuses what a pattern cannot (a port above 65535). */
function normalisedOrigins(list: readonly string[]): ReadonlySet<string> {
  return new Set(
    list.map((entry) => {
      const origin = parseOrigin(entry);
      if (origin === undefined) throw new InvalidOption(`${ALLOWED_ORIGINS_KEY} entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port])`);
      return origin;
    }),
  );
}

const trimSlashes = (v: string): string => v.replace(/^\/+|\/+$/g, '');

/** Case-insensitive and slash-tolerant like the router, so a variant spelling of a listed path cannot slip past. */
function routeKey(path: string): string {
  return `/${trimSlashes(path).toLowerCase()}`;
}

/** The listed routes as they are requested: behind the global route prefix. */
function listedPaths(routes: readonly string[], prefix: string | undefined): ReadonlySet<string> {
  const base = trimSlashes(prefix ?? '');
  return new Set(
    routes.map((route) => {
      if (!route.startsWith('/')) throw new InvalidOption(`${UNAUTHENTICATED_ROUTES_KEY} entry ${JSON.stringify(route)} is not an absolute path`);
      return routeKey(base === '' ? route : `/${base}${route}`);
    }),
  );
}

const SHOWN_MAX = 120;

const clip = (v: string): string => (v.length > SHOWN_MAX ? `${v.slice(0, SHOWN_MAX)}…` : v);

/**
 * Request headers are client input: only a well-formed origin is logged, never cookies. How many of these lines are
 * written is left to `logger.filters` (CSRF_REFUSAL_LOG_FILTERS, shipped in the package config).
 */
function warnRefused(log: Log, origin: string | undefined, fetchSite: unknown, own: string | undefined): void {
  const site = typeof fetchSite === 'string' && /^[a-z-]{1,16}$/.test(fetchSite) ? fetchSite : 'absent';
  const shown = origin === undefined ? `none (Sec-Fetch-Site ${site})` : (parseOrigin(origin) ?? 'malformed');
  log.warn(
    { event: CSRF_REFUSED_EVENT, origin: clip(shown), ownOrigin: own === undefined ? 'unknown (no usable Host)' : clip(own), allowedOriginsKey: ALLOWED_ORIGINS_KEY },
    'CsrfOriginGuard refused a request: Origin ${origin}, own origin ${ownOrigin}. ' +
      'Behind a proxy set authn.http.trustProxy (or http.trustProxy) so the own origin comes from X-Forwarded-Proto/-Host, or list the origin in ${allowedOriginsKey}.',
  );
}

function carriesCookie(header: string | undefined, names: readonly string[]): boolean {
  return (header ?? '').split(';').some((pair) => names.includes(pair.split('=')[0].trim()));
}

/**
 * Order 4, before AuthnMiddleware; off when authn.http.csrf.enabled is false. A request with an unsafe method (any but
 * GET, HEAD and OPTIONS) that carries the session cookie passes only when Origin (or, without it, Sec-Fetch-Site:
 * same-origin) is the app's own origin or in authn.http.csrf.allowedOrigins; else 403 before any controller (A22,
 * SR-12). Without the cookie only the paths in authn.http.csrf.unauthenticatedRoutes (login and the other
 * credential-taking posts) are checked, and then a request with neither Origin nor Sec-Fetch-Site (a non-browser
 * client) passes; this closes login CSRF.
 */
@Injectable(ServerMiddleware)
export class CsrfOriginGuard extends ServerMiddleware {
  @Config('authn.http.csrf.enabled')
  protected Enabled: boolean;

  @Config('authn.http.csrf.allowedOrigins')
  protected AllowedOrigins: string[];

  @Config('authn.http.csrf.unauthenticatedRoutes')
  protected UnauthenticatedRoutes: string[];

  @Config('http.controllers.route.prefix')
  protected RoutePrefix: string;

  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig;

  @Logger('authn-http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 4;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    // Built before the enabled check, so a bad setting fails the boot even while the guard is off.
    const allowed = normalisedOrigins(this.AllowedOrigins);
    const listed = listedPaths(this.UnauthenticatedRoutes ?? [], this.RoutePrefix);
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    if (this.Enabled === false) return null;

    // authn-session adds the __Host- prefix only when its `hostPrefix` setting resolves on (`auto` is off in
    // development and test), so either form can be the session cookie.
    const base = this.SessionCookie?.name ?? SESSION_COOKIE_BASE_NAME;
    const sessionCookies = [base, `__Host-${base}`];

    return (req: Request, res: express.Response, next: express.NextFunction) => {
      if (SAFE_METHODS.has(req.method)) return next();

      const origin = req.headers.origin;
      if (!carriesCookie(req.headers.cookie, sessionCookies)) {
        const checked = listed.has(routeKey(req.path ?? '')) && (origin !== undefined || req.headers['sec-fetch-site'] !== undefined);
        if (!checked) return next();
      }

      const own = origin === undefined ? undefined : ownOrigin(req, trust);
      const allowedRequest = origin === undefined ? req.headers['sec-fetch-site'] === 'same-origin' : allowed.has(origin) || origin === own;
      if (allowedRequest) return next();

      warnRefused(this.Log, origin, req.headers['sec-fetch-site'], origin === undefined ? ownOrigin(req, trust) : own);
      res.status(HTTP_STATUS_CODE.FORBIDDEN).json(REFUSED);
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
