import { Autoinject, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_STATUS_CODE, ServerMiddleware, parseOrigin, requestOrigin } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import { SESSION_COOKIE_BASE_NAME } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { Log, Logger } from '@spinajs/log';
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

function isEnabled(config: Configuration): boolean {
  const csrf = config.get<unknown>('authn.http.csrf');
  if (csrf !== undefined && csrf !== null && (typeof csrf !== 'object' || Array.isArray(csrf))) {
    throw new InvalidOption('authn.http.csrf must be an object ({ enabled, allowedOrigins })');
  }
  const enabled = config.get<unknown>('authn.http.csrf.enabled');
  if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
    throw new InvalidOption(`authn.http.csrf.enabled must be true or false; got ${JSON.stringify(enabled)}`);
  }
  return enabled !== false;
}

const WARN_INTERVAL_MS = 60_000;
const WARN_KEYS_MAX = 256;

/** At most one warning per (Origin, own origin) pair a minute, from a bounded table, so a flood cannot fill the log. */
class RefusalWarnings {
  private readonly last = new Map<string, number>();

  constructor(private readonly log: () => Log | undefined) {}

  public refused(origin: string | undefined, fetchSite: unknown, own: string | undefined): void {
    // Request headers are client input: only a well-formed origin is logged, never cookies.
    const site = typeof fetchSite === 'string' && /^[a-z-]{1,16}$/.test(fetchSite) ? fetchSite : 'absent';
    const shown = origin === undefined ? `none (Sec-Fetch-Site ${site})` : (parseOrigin(origin) ?? 'malformed');
    const key = `${shown}|${own ?? ''}`;
    const now = Date.now();
    const at = this.last.get(key);
    if (at !== undefined && now - at < WARN_INTERVAL_MS) return;
    if (at === undefined && this.last.size >= WARN_KEYS_MAX) this.last.clear();
    this.last.set(key, now);
    this.log()?.warn(
      `CsrfOriginGuard refused a cookie request: Origin ${shown}, own origin ${own ?? 'unknown (no usable Host)'}. ` +
        `Behind a proxy set authn.http.trustProxy (or http.trustProxy) so the own origin comes from X-Forwarded-Proto/-Host, or list the origin in ${ALLOWED_ORIGINS_KEY}.`,
    );
  }
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
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Logger('authn-http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 4;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    const enabled = isEnabled(this.Configuration);
    const allowed = allowedOrigins(this.Configuration.get<unknown>(ALLOWED_ORIGINS_KEY));
    const trust = authnProxyTrust(this.Configuration);
    if (!enabled) return null;

    // Until AuthnMiddleware replaces the 2.x session code, that code and authn-session can disagree on the
    // __Host- prefix, so both forms count as the session cookie.
    const base = this.Configuration.get<ISessionCookieConfig>('authn.session.cookie', {})?.name ?? SESSION_COOKIE_BASE_NAME;
    const sessionCookies = [base, `__Host-${base}`];
    const warnings = new RefusalWarnings(() => this.Log);

    return (req: Request, res: express.Response, next: express.NextFunction) => {
      if (SAFE_METHODS.has(req.method) || !carriesCookie(req.headers.cookie, sessionCookies)) return next();

      const origin = req.headers.origin;
      const own = origin === undefined ? undefined : ownOrigin(req, trust);
      const allowedRequest = origin === undefined ? req.headers['sec-fetch-site'] === 'same-origin' : allowed.has(origin) || origin === own;
      if (allowedRequest) return next();

      warnings.refused(origin, req.headers['sec-fetch-site'], origin === undefined ? ownOrigin(req, trust) : own);
      res.status(HTTP_STATUS_CODE.FORBIDDEN).json(REFUSED);
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }
}
