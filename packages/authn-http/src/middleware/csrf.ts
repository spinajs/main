import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_STATUS_CODE, ServerMiddleware, parseOrigin, requestOrigin } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import { SESSION_COOKIE_BASE_NAME } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { Log, Logger, RateLimitedLog } from '@spinajs/log';
import type * as express from 'express';

import { proxyTrustOf } from './client-ip.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_ORIGINS_KEY = 'authn.http.csrf.allowedOrigins';
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


const WARN_INTERVAL_MS = 60_000;
const WARN_KEYS_MAX = 256;
const WARN_LINES_PER_INTERVAL = 20;
const SHOWN_MAX = 120;

const clip = (v: string): string => (v.length > SHOWN_MAX ? `${v.slice(0, SHOWN_MAX)}…` : v);

/** Request headers are client input: only a well-formed origin is logged, never cookies. */
function warnRefused(warnings: RateLimitedLog, origin: string | undefined, fetchSite: unknown, own: string | undefined): void {
  const site = typeof fetchSite === 'string' && /^[a-z-]{1,16}$/.test(fetchSite) ? fetchSite : 'absent';
  const shown = origin === undefined ? `none (Sec-Fetch-Site ${site})` : (parseOrigin(origin) ?? 'malformed');
  warnings.warn(
    `${shown}|${own ?? ''}`,
    { origin: clip(shown), ownOrigin: own === undefined ? 'unknown (no usable Host)' : clip(own), allowedOriginsKey: ALLOWED_ORIGINS_KEY },
    'CsrfOriginGuard refused a cookie request: Origin ${origin}, own origin ${ownOrigin}. ' +
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
 * SR-12). Requests without the session cookie are not checked, login included.
 */
@Injectable(ServerMiddleware)
export class CsrfOriginGuard extends ServerMiddleware {
  @Config('authn.http.csrf.enabled')
  protected Enabled: boolean;

  @Config('authn.http.csrf.allowedOrigins')
  protected AllowedOrigins: string[];

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
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    if (this.Enabled === false) return null;

    // authn-session adds the __Host- prefix only when its `hostPrefix` setting resolves on (`auto` is off in
    // development and test), so either form can be the session cookie.
    const base = this.SessionCookie?.name ?? SESSION_COOKIE_BASE_NAME;
    const sessionCookies = [base, `__Host-${base}`];
    // One line per (Origin, own origin) pair a minute and WARN_LINES_PER_INTERVAL a minute in all, so requests that
    // vary the headers cannot turn refusals into one log line each.
    const warnings = new RateLimitedLog(() => this.Log, { intervalMs: WARN_INTERVAL_MS, maxPerInterval: WARN_LINES_PER_INTERVAL, maxKeys: WARN_KEYS_MAX });

    return (req: Request, res: express.Response, next: express.NextFunction) => {
      if (SAFE_METHODS.has(req.method) || !carriesCookie(req.headers.cookie, sessionCookies)) return next();

      const origin = req.headers.origin;
      const own = origin === undefined ? undefined : ownOrigin(req, trust);
      const allowedRequest = origin === undefined ? req.headers['sec-fetch-site'] === 'same-origin' : allowed.has(origin) || origin === own;
      if (allowedRequest) return next();

      warnRefused(warnings, origin, req.headers['sec-fetch-site'], origin === undefined ? ownOrigin(req, trust) : own);
      res.status(HTTP_STATUS_CODE.FORBIDDEN).json(REFUSED);
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
