import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_STATUS_CODE, ServerMiddleware, parseOrigin, requestOrigin } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import { appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import type * as express from 'express';

import { authnProxyTrust } from './client-ip.js';

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

function allowedOrigins(value: unknown): ReadonlySet<string> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) throw new InvalidOption(`${ALLOWED_ORIGINS_KEY} must be a list of origins (scheme://host[:port])`);
  return new Set(
    value.map((entry: unknown) => {
      const origin = parseOrigin(entry);
      if (origin === undefined) throw new InvalidOption(`${ALLOWED_ORIGINS_KEY} entry ${JSON.stringify(entry) ?? String(entry)} is not an origin (scheme://host[:port])`);
      return origin;
    }),
  );
}

function carriesCookie(header: string | undefined, names: readonly string[]): boolean {
  return (header ?? '').split(';').some((pair) => names.includes(pair.split('=')[0].trim()));
}

/**
 * Order 4, before AuthnMiddleware; off when authn.http.csrf.enabled is false. An unsafe method carrying the session cookie passes only
 * when Origin (or, without it, Sec-Fetch-Site: same-origin) is the app's own origin or in authn.http.csrf.allowedOrigins; else 403
 * before any controller (A22, SR-12). A22 exempts requests without the session cookie (token, key, signature); the guard may still
 * check the routes that issue a session (login CSRF).
 */
@Injectable(ServerMiddleware)
export class CsrfOriginGuard extends ServerMiddleware {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  constructor() {
    super();
    this.Order = 4;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    const allowed = allowedOrigins(this.Configuration.get<unknown>(ALLOWED_ORIGINS_KEY));
    const trust = authnProxyTrust(this.Configuration);
    if (this.Configuration.get<unknown>('authn.http.csrf.enabled') === false) return null;

    const name = sessionCookieName(this.Configuration.get<ISessionCookieConfig>('authn.session.cookie', {}), appEnvOf(this.Configuration));
    const base = name.replace(/^__Host-/, '');
    // The 2.x session code names the cookie by its own hostPrefix rule until AuthnMiddleware replaces it, so the
    // prefixed and the bare name both count as the session cookie.
    const sessionCookies = [base, `__Host-${base}`];

    return (req: Request, res: express.Response, next: express.NextFunction) => {
      if (SAFE_METHODS.has(req.method) || !carriesCookie(req.headers.cookie, sessionCookies)) return next();

      const origin = req.headers.origin;
      const allowedRequest = origin === undefined ? req.headers['sec-fetch-site'] === 'same-origin' : allowed.has(origin) || origin === ownOrigin(req, trust);
      if (allowedRequest) return next();

      res.status(HTTP_STATUS_CODE.FORBIDDEN).json(REFUSED);
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
