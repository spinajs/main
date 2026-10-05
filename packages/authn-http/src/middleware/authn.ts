import { createHash, randomBytes } from 'node:crypto';
import * as cs from 'cookie-signature';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Log, Logger } from '@spinajs/log';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { CredentialExtractor, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, Principal, SignedRequest } from '@spinajs/authn/contracts';
import { PUBLIC_DEFAULT_COOKIE_SECRET, appEnvOf, assertSessionCookieSecret, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import type * as express from 'express';

import { AuthnPrincipalResolver } from '../api.js';
import { publicOriginOf } from '../extractors/signature.js';

type Restored = NonNullable<Awaited<ReturnType<SessionIssuer['restore']>>>;

const byOrder = (a: { order: number }, b: { order: number }): number => a.order - b.order;

// Domain-separated and cut short: sha256 of a raw session id is its storage key, which must not reach a log.
const logHash = (value: string): string => createHash('sha256').update(`authn-http:log\0${value}`).digest('hex').slice(0, 16);

function headersOf(req: Request): Record<string, string> {
  // From rawHeaders: req.headers keeps only the first of a repeated Authorization header.
  const headers: Record<string, string> = Object.create(null);
  const raw = req.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    headers[name] = name in headers ? `${headers[name]}, ${raw[i + 1]}` : raw[i + 1];
  }
  return headers;
}

function bodyOf(req: Request): Uint8Array | undefined {
  const raw = (req as { rawBody?: unknown }).rawBody;
  if (raw instanceof Uint8Array) return raw;
  const length = req.headers['content-length'];
  const hasBody = req.headers['transfer-encoding'] !== undefined || (length !== undefined && length.trim() !== '0');
  // A body whose bytes no parser kept must not verify as body-less: random bytes no client can have signed a digest of.
  return hasBody ? randomBytes(32) : undefined;
}

/**
 * Order 5, after ClientIp and CsrfOriginGuard and every http built-in (≤ 3); authz-http's PrincipalMiddleware must come later.
 * Restores the session cookie into req.storage.AuthnSession. Without an active session it takes the first CredentialExtractor answer
 * (an active session ignores bearer credentials), asks the AuthnPrincipalResolvers in ascending order and writes the first answer
 * that is not undefined, else null, to req.storage.AuthnPrincipal (D26).
 *
 * The cookie is a browser-session cookie the issuer slides server side (N8a-D7), so it is never re-sent here. Store
 * errors go to next(err): no principal, never a silent anonymous. Registered on the root container when the package loads
 * (registerAuthnHttpV3).
 */
export class AuthnMiddleware extends ServerMiddleware {
  // Stays an injected Configuration: appEnvOf reads its Env for the SR-16 "no env named" rule, which @Config cannot express.
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Config('http.cookie.secret')
  protected ConfiguredCookieSecret: string;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig;

  @Config('authn.http.publicOrigin')
  protected PublicOrigin: string | null | undefined;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Logger('authn-http')
  protected Log!: Log;

  protected Sessions!: SessionIssuer;
  protected Extractors: readonly CredentialExtractor[] = [];
  protected Resolvers: readonly AuthnPrincipalResolver[] = [];
  protected CookieName!: string;
  protected CookieSecret!: string;

  constructor() {
    super();
    this.Order = 5;
  }

  public async resolve(): Promise<void> {
    const env = appEnvOf(this.Configuration);
    const secret = this.ConfiguredCookieSecret;
    assertSessionCookieSecret(secret, env);
    if (secret === PUBLIC_DEFAULT_COOKIE_SECRET) {
      this.Log.warn('http.cookie.secret is the public default shipped with @spinajs/http; session cookies can be forged. Set a secret of your own');
    }
    if (publicOriginOf(this.PublicOrigin) === undefined) {
      this.Log.warn('authn.http.publicOrigin is not set: requests signed with HTTP message signatures get no principal');
    }
    this.CookieSecret = secret;
    this.CookieName = sessionCookieName(this.SessionCookie, env);
    this.Sessions = await this.Container.resolve(SessionIssuer);
    this.Extractors = [...(await this.Container.resolve(Array.ofType(CredentialExtractor)))].sort(byOrder);
    this.Resolvers = [...(await this.Container.resolve(Array.ofType(AuthnPrincipalResolver)))].sort(byOrder);
    await super.resolve();
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    return async (req: Request, res: express.Response, next: express.NextFunction) => {
      try {
        await this.authenticate(req, res);
      } catch (err) {
        return next(err);
      }
      next();
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }

  protected async authenticate(req: Request, res: express.Response): Promise<void> {
    req.storage.AuthnSession = null;
    req.storage.AuthnPrincipal = null;
    const ctx = this.contextOf(req);

    const session = await this.restoreSession(req);
    req.storage.AuthnSession = session;
    if (session) res.setHeader('Cache-Control', 'no-store');

    const credentials = session?.handle.state === 'active' ? null : this.extract(req);
    const principal = await this.principalOf(req, credentials, ctx);
    req.storage.AuthnPrincipal = principal;
    if (principal) res.setHeader('Cache-Control', 'no-store');
    // An active session without a principal has ended (revoked or expired) or gives nothing, so no route may act on it.
    else if (session?.handle.state === 'active') req.storage.AuthnSession = null;
  }

  protected contextOf(req: Request): AuthnContext {
    const ip = req.storage.ClientIp;
    const userAgent = req.headers['user-agent'];
    return { ...(typeof ip === 'string' ? { ip } : {}), ...(typeof userAgent === 'string' ? { userAgent } : {}), now: new Date(), purpose: 'request' };
  }

  /**
   * The cookie as 2.x accepted it: signed by hand (http `_setCoockies`) in req.cookies, or `s:`-signed by express,
   * which cookie-parser verifies into req.signedCookies (false for a bad signature).
   */
  protected async restoreSession(req: Request): Promise<Restored | null> {
    const raw: unknown = req.cookies?.[this.CookieName];
    const signed: unknown = req.signedCookies?.[this.CookieName];
    let id: string | false | undefined;
    if (typeof raw === 'string' && raw !== '') id = cs.unsign(raw, this.CookieSecret);
    else if (typeof signed === 'string' || signed === false) id = signed;

    if (id === false) {
      this.Log.warn('Rejected a session cookie with an invalid signature', { Cookie: typeof raw === 'string' ? logHash(raw) : undefined, Ip: req.storage.ClientIp });
      return null;
    }
    if (!id) return null;

    const restored = await this.Sessions.restore(id);
    if (!restored) this.Log.warn('Session cookie names no live session (expired or unknown)', { Session: logHash(id), Ip: req.storage.ClientIp });
    return restored;
  }

  /** `targetUri` is the origin-form target (path and query); the signature extractor adds authn.http.publicOrigin. */
  protected extract(req: Request): Credentials | null {
    const target = req.originalUrl ?? req.url;
    // An absolute-form or '*' target is no target any client signs.
    if (typeof target !== 'string' || !target.startsWith('/')) return null;
    let body: Uint8Array | undefined | null = null;
    const signed: SignedRequest = {
      method: req.method,
      targetUri: target,
      headers: headersOf(req),
      // Only the signature extractor reads it, so a request without signature headers draws no random bytes.
      get body() {
        if (body === null) body = bodyOf(req);
        return body;
      },
    };
    for (const extractor of this.Extractors) {
      const credentials = extractor.extract(signed);
      if (credentials !== null) return credentials;
    }
    return null;
  }

  protected async principalOf(req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null> {
    for (const resolver of this.Resolvers) {
      const principal = await resolver.resolve(req, credentials, ctx);
      if (principal !== undefined) return principal;
    }
    return null;
  }
}
