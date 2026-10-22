import type * as express from 'express';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn-session/register-schema';
import { AuthnService, IdentityLinkStore, NonceStore, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, SessionHandle } from '@spinajs/authn/contracts';
import { proxyTrustOf } from '@spinajs/authn-http';
import { sessionCookie } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { BaseController, BasePath, Del, Get, Param, Post, Req, Response, Unauthorized, _setCoockies, _setHeaders, isTrustedPeer } from '@spinajs/http';
import type { ICookie, Request, ResponseFunction } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { Hooks } from '@spinajs/hooks';

import { OidcLogin } from '../login.js';
import { OidcBackchannelLogout } from '../token/logout-token.js';
import type { OidcAnswer, OidcRequest } from '../login.js';
import { OidcAccountLinks } from '../links.js';
import { OidcProviders } from '../providers.js';
import { requestOrigin } from '../origin.js';
import { isRelaxedEnv } from '../support.js';

const ROUTE_PREFIX = 'auth/oidc';
const FORM = 'application/x-www-form-urlencoded';

/** Maps an OidcAnswer to express; a 401 goes through Unauthorized, as the login route's, so A02's bodies match. */
export class OidcResponse extends Response {
  constructor(protected readonly answer: OidcAnswer) {
    super(null);
  }

  public async execute(req: express.Request, res: express.Response): Promise<ResponseFunction | void> {
    const a = this.answer;
    const cookies = a.cookies as unknown as ICookie[];
    const headers = Object.entries({ 'cache-control': 'no-store', ...a.headers }).map(([Name, Value]) => ({ Name, Value }));
    if (a.status === 401) {
      // Unauthorized answers a function the server calls with req and res; hand it back unchanged.
      return new Unauthorized(a.body ?? null, { Coockies: cookies, Headers: headers }).execute(req, res);
    }
    _setCoockies(res, { Coockies: cookies });
    _setHeaders(res, { Headers: headers });
    if (a.location !== undefined) {
      // express encodes the URL; the target is an app path or the provider's authorization URL.
      res.redirect(a.status, a.location);
    } else if (a.html !== undefined) {
      res.status(a.status).type('html').send(a.html);
    } else if (a.body !== undefined) {
      res.status(a.status).json(a.body);
    } else {
      res.status(a.status).end();
    }
  }
}

const isNavigation = (req: Request): boolean => req.get('sec-fetch-mode') === 'navigate' || /\btext\/html\b/i.test(req.get('accept') ?? '');

/**
 * `GET /auth/oidc/:provider`, `GET /auth/oidc/:provider/callback`, the link routes `POST` / `DELETE
 * /auth/oidc/:provider/link` (design §22.15), and `POST /auth/oidc/:provider/backchannel-logout`, which the IdP calls
 * without a session cookie, so the CSRF guard lets it through. The logic lives in OidcLogin; this maps express to it. The restored
 * session comes from authn-http's middleware (`req.storage.AuthnSession`).
 */
@BasePath(ROUTE_PREFIX)
export class OidcController extends BaseController {
  @Logger('authn-oidc')
  protected Log: Log;

  protected flow: Promise<OidcLogin> | undefined;
  protected logout: OidcBackchannelLogout | undefined;
  protected peerTrusted: ((peer: string | undefined) => boolean) | undefined;
  protected warnedHttpOrigin = false;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig;

  @Autoinject(OidcProviders)
  protected Providers: OidcProviders;

  @Autoinject(SessionIssuer)
  protected Sessions: SessionIssuer;

  @Autoinject(OidcAccountLinks, { optional: true })
  protected Linker: OidcAccountLinks | undefined;

  @Autoinject(IdentityLinkStore, { optional: true })
  protected Links: IdentityLinkStore | undefined;

  @Autoinject(NonceStore)
  protected Nonces: NonceStore;

  @Autoinject(Hooks)
  protected Hooks: Hooks;

  @Get(':provider')
  public async begin(@Param() provider: string, @Req() req: Request) {
    const login = await this.login();
    return new OidcResponse(await login.begin(provider, this.requestOf(req)));
  }

  @Get(':provider/callback')
  public async callback(@Param() provider: string, @Req() req: Request) {
    const login = await this.login();
    return new OidcResponse(await login.callback(provider, this.requestOf(req)));
  }

  @Post(':provider/link')
  public async beginLink(@Param() provider: string, @Req() req: Request) {
    const login = await this.login();
    return new OidcResponse(await login.beginLink(provider, this.requestOf(req)));
  }

  @Del(':provider/link')
  public async unlink(@Param() provider: string, @Req() req: Request) {
    const login = await this.login();
    return new OidcResponse(await login.unlink(provider, this.requestOf(req)));
  }

  @Post(':provider/backchannel-logout')
  public async backchannelLogout(@Param() provider: string, @Req() req: Request): Promise<OidcResponse> {
    this.logout ??= new OidcBackchannelLogout({
      strategies: this.Providers.strategies(),
      sessions: this.Sessions,
      links: this.Links ?? null,
      nonces: this.Nonces,
      log: { warn: (...args: unknown[]) => this.Log?.warn(...(args as Parameters<Log['warn']>)) },
      hooks: this.Hooks,
    });
    // Section 2.5: the token comes form-encoded only.
    const form = req.is(FORM) ? req.body : undefined;
    const now = new Date();
    return new OidcResponse(await this.logout.receive(provider, form, now, { ...this.contextOf(req, now), purpose: 'request' }));
  }

  /** Re-authenticates the current session at the provider; the callback refreshes its authenticatedAt (FreshAuth). */
  @Get(':provider/reauth')
  public async reauth(@Param() provider: string, @Req() req: Request) {
    const login = await this.login();
    return new OidcResponse(await login.beginReauth(provider, this.requestOf(req)));
  }

  protected contextOf(req: Request, now: Date): AuthnContext {
    const storage = (req as unknown as { storage?: { ClientIp?: string } }).storage;
    const userAgent = req.get('user-agent');
    return { now, purpose: 'login', ...(storage?.ClientIp ? { ip: storage.ClientIp } : {}), ...(userAgent ? { userAgent } : {}) };
  }

  protected requestOf(req: Request): OidcRequest {
    const storage = (req as unknown as { storage?: { AuthnSession?: { handle: SessionHandle } | null } }).storage;
    const ctx = this.contextOf(req, new Date());
    return {
      origin: this.originOf(req),
      cookies: (req.cookies ?? {}) as Record<string, string>,
      query: req.query as Record<string, unknown>,
      navigation: isNavigation(req),
      ctx,
      session: storage?.AuthnSession?.handle ?? null,
      ...(req.get('sec-fetch-site') ? { fetchSite: req.get('sec-fetch-site') } : {}),
    };
  }

  protected originOf(req: Request): string {
    const socket = req.socket as { encrypted?: boolean; remoteAddress?: string };
    const origin = requestOrigin({ encrypted: socket.encrypted === true, peer: socket.remoteAddress, host: req.get('host'), forwardedProto: req.get('x-forwarded-proto'), forwardedHost: req.get('x-forwarded-host') }, this.trusted);
    if (!this.warnedHttpOrigin && origin.startsWith('http:') && !isRelaxedEnv(this.env)) {
      this.warnedHttpOrigin = true;
      this.Log?.warn('authn-oidc: the default redirect_uri has an http origin; behind a TLS proxy set authn.http.trustProxy (or http.trustProxy) or the provider redirectUri');
    }
    return origin;
  }

  protected get env(): string | undefined {
    return this.Providers.env;
  }

  protected get trusted(): (peer: string | undefined) => boolean {
    return (this.peerTrusted ??= this.peerTrust());
  }

  /** The trust setting of ClientIp and the CSRF guard, parsed by the shared parser; throws, naming the key, for an entry that is no address. */
  protected peerTrust(): (peer: string | undefined) => boolean {
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    return (peer) => isTrustedPeer(trust, peer);
  }

  protected login(): Promise<OidcLogin> {
    // A failed build is not kept, so the next request retries it.
    this.flow ??= this.buildLogin().catch((e: unknown) => {
      this.flow = undefined;
      throw e;
    });
    return this.flow;
  }

  protected async buildLogin(): Promise<OidcLogin> {
    const providers = this.Providers;
    const cookieConfig = this.SessionCookie;
    return new OidcLogin({
      strategies: providers.strategies(),
      // Not injected: an eager AuthnService builds its checked neighbours, missing in apps without them.
      service: await this.Container.resolve(AuthnService),
      sessions: this.Sessions,
      redirects: providers.options.redirects,
      env: providers.env,
      sessionCookie: (h) => sessionCookie(h.id, cookieConfig, undefined, providers.env),
      callbackPath: (p) => `/${ROUTE_PREFIX}/${encodeURIComponent(p)}/callback`,
      linker: this.Linker ?? null,
      links: this.Links ?? null,
      log: { warn: (...args: unknown[]) => this.Log?.warn(...(args as Parameters<Log['warn']>)), error: (...args: unknown[]) => this.Log?.error(...(args as Parameters<Log['error']>)) },
    });
  }
}
