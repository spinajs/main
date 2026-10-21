import { Autoinject, Injectable } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { isLenientAuthnEnv } from '@spinajs/authn/env';
import '../register-schema.js';
import '@spinajs/authn-session/register-schema';
import { CsrfGuard, HTTP_STATUS_CODE, CSRF_REFUSED_BODY, ServerMiddleware, parseAllowedOrigins, parseOrigin, requestOrigin } from '@spinajs/http';
import type { OriginRefusal, ProxyTrust, Request } from '@spinajs/http';
import { SESSION_COOKIE_BASE_NAME, appEnvOf, sessionCookieSameSite } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { Log, Logger } from '@spinajs/log';
import type * as express from 'express';

import { proxyTrustOf } from './client-ip.js';
import { CSRF_REFUSED_EVENT } from './csrf-log.js';

const DEPRECATED_ALLOWED_ORIGINS_KEY = 'authn.http.csrf.allowedOrigins';

export interface SameSiteNoneCheck {
  /** From `sessionCookieSameSite`. */
  readonly sameSite: 'strict' | 'lax' | 'none' | false;
  readonly csrfEnabled: boolean;
  readonly allowedOrigins: ReadonlySet<string>;
  /** From `appEnvOf`; absent means production. */
  readonly env: string | undefined;
}

/**
 * With SameSite=None browsers send the session cookie on cross-site requests, so the origin check is the only CSRF
 * defence, and a cross-site embed needs its origin listed anyway. Outside development and test, throws when the guard is
 * off or lists no allowed origin.
 */
export function assertSameSiteNoneProtected(check: SameSiteNoneCheck): void {
  if (check.sameSite !== 'none' || isLenientAuthnEnv(check.env)) return;
  if (!check.csrfEnabled || check.allowedOrigins.size === 0) {
    throw new InvalidOption(
      'authn.session.cookie.sameSite is none, so browsers send the session cookie on cross-site requests: keep the CSRF guard on (http.csrf.enabled) and list the cross-site origins that use the session in http.csrf.allowedOrigins, or use SameSite strict or lax',
    );
  }
}

/**
 * The app's own origin for this request: scheme from the connection and host from Host, or X-Forwarded-Proto and
 * -Host from a trusted proxy only. undefined when they do not make an origin (no Host, or a Host with a path).
 */
export function ownOrigin(req: Parameters<typeof requestOrigin>[0], trust: ProxyTrust): string | undefined {
  return parseOrigin(requestOrigin(req, trust));
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
    { event: CSRF_REFUSED_EVENT, origin: clip(shown), ownOrigin: own === undefined ? 'unknown (no usable Host)' : clip(own), allowedOriginsKey: 'http.csrf.allowedOrigins' },
    'CsrfOriginGuard refused a request: Origin ${origin}, own origin ${ownOrigin}. ' +
      'Behind a proxy set authn.http.trustProxy (or http.trustProxy) so the own origin comes from X-Forwarded-Proto/-Host, or list the origin in ${allowedOriginsKey}.',
  );
}

/**
 * The @spinajs/http CsrfGuard with what authn-http knows: the session cookie (bare and `__Host-`) is an ambient
 * cookie, the own origin follows authn.http.trustProxy, and refusals are logged. Replaces the plain CsrfGuard.
 *
 * `authn.http.csrf.*` are deprecated aliases of `http.csrf.*` until the next major: `enabled: false` in either switches
 * the guard off, and both allowedOrigins lists count. `unauthenticatedRoutes` is ignored, since every request a
 * browser sends is checked now.
 */
@Injectable(ServerMiddleware)
export class CsrfOriginGuard extends CsrfGuard {
  @Config('authn.http.csrf.enabled')
  protected DeprecatedEnabled: unknown;

  @Config('authn.http.csrf.allowedOrigins')
  protected DeprecatedAllowedOrigins: readonly string[] | null;

  @Config('authn.http.csrf.unauthenticatedRoutes')
  protected DeprecatedUnauthenticatedRoutes: readonly string[] | undefined;

  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig;

  // An injected Configuration: appEnvOf reads its Env for the SR-16 rule, which @Config cannot express.
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Logger('authn-http')
  protected Log!: Log;

  protected Trust: ProxyTrust = { hops: 0 };

  protected enabled(): boolean {
    return super.enabled() && this.DeprecatedEnabled !== false;
  }

  protected allowedOrigins(): ReadonlySet<string> {
    return new Set([...super.allowedOrigins(), ...parseAllowedOrigins(this.DeprecatedAllowedOrigins, DEPRECATED_ALLOWED_ORIGINS_KEY)]);
  }

  protected ambientCookies(): readonly string[] {
    // authn-session adds the __Host- prefix only when its `hostPrefix` setting resolves on (`auto` is off in
    // development and test), so either form can be the session cookie.
    const base = this.SessionCookie?.name ?? SESSION_COOKIE_BASE_NAME;
    return [...super.ambientCookies(), base, `__Host-${base}`];
  }

  protected ownOrigin(req: Request): string | undefined {
    return ownOrigin(req, this.Trust);
  }

  protected refuse(_reason: OriginRefusal, req: Request, res: express.Response, _next: express.NextFunction): void {
    warnRefused(this.Log, req.headers.origin, req.headers['sec-fetch-site'], this.ownOrigin(req));
    res.status(HTTP_STATUS_CODE.FORBIDDEN).json(CSRF_REFUSED_BODY);
  }

  public async resolve(): Promise<void> {
    assertSameSiteNoneProtected({ sameSite: sessionCookieSameSite(this.SessionCookie ?? {}), csrfEnabled: this.enabled(), allowedOrigins: this.allowedOrigins(), env: appEnvOf(this.Configuration) });
    await super.resolve();
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    this.Trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    this.warnDeprecated();
    return super.before();
  }

  private warnDeprecated(): void {
    const used = [
      this.DeprecatedEnabled === false ? 'enabled' : undefined,
      (this.DeprecatedAllowedOrigins ?? []).length > 0 ? 'allowedOrigins' : undefined,
      this.DeprecatedUnauthenticatedRoutes !== undefined ? 'unauthenticatedRoutes' : undefined,
    ].filter((k) => k !== undefined);
    if (used.length === 0) return;
    this.Log?.warn?.(
      { keys: used.map((k) => `authn.http.csrf.${k}`).join(', ') },
      '${keys} is deprecated and will be removed in the next major: use http.csrf.* (unauthenticatedRoutes has no successor; every browser request is checked).',
    );
  }
}
