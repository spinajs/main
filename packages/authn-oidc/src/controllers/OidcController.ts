import type * as express from 'express';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthnService, IdentityLinkStore, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, SessionHandle } from '@spinajs/authn/contracts';
import { sessionCookie } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { BaseController, BasePath, Del, Get, Param, Post, Req, Response, Unauthorized, _setCoockies, _setHeaders } from '@spinajs/http';
import type { ICookie, Request, ResponseFunction } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { OidcLogin } from '../login.js';
import type { OidcAnswer, OidcRequest } from '../login.js';
import { OidcAccountLinks } from '../links.js';
import { OidcProviders } from '../providers.js';
import { requestOrigin, trustedPeer } from '../origin.js';
import { isRelaxedEnv } from '../support.js';

const ROUTE_PREFIX = 'auth/oidc';

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
 * `GET /auth/oidc/:provider`, `GET /auth/oidc/:provider/callback`, and the link routes `POST` / `DELETE
 * /auth/oidc/:provider/link` (design §22.15). The logic lives in OidcLogin; this maps express to it. The restored
 * session comes from authn-http's middleware (`req.storage.AuthnSession`).
 */
@BasePath(ROUTE_PREFIX)
export class OidcController extends BaseController {
  @Logger('authn-oidc')
  protected Log: Log;

  protected flow: OidcLogin | undefined;
  protected trusted: (peer: string | undefined) => boolean = () => false;
  protected warnedHttpOrigin = false;

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

  protected requestOf(req: Request): OidcRequest {
    const storage = (req as unknown as { storage?: { ClientIp?: string; AuthnSession?: { handle: SessionHandle } | null } }).storage;
    const userAgent = req.get('user-agent');
    const ctx: AuthnContext = { now: new Date(), purpose: 'login', ...(storage?.ClientIp ? { ip: storage.ClientIp } : {}), ...(userAgent ? { userAgent } : {}) };
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

  protected env: string | undefined;

  protected async login(): Promise<OidcLogin> {
    if (this.flow) return this.flow;
    const providers = await DI.resolve(OidcProviders);
    const config = DI.get(Configuration)!;
    this.env = providers.env;
    const authnTrust = config.get<unknown>('authn.http.trustProxy');
    this.trusted = trustedPeer((authnTrust ?? config.get<unknown>('http.trustProxy')) as never);
    const cookieConfig = config.get<ISessionCookieConfig>('authn.session.cookie', {});
    this.flow = new OidcLogin({
      strategies: providers.strategies(),
      service: await DI.resolve(AuthnService),
      sessions: await DI.resolve(SessionIssuer),
      redirects: providers.options.redirects,
      env: providers.env,
      sessionCookie: (h) => sessionCookie(h.id, cookieConfig, undefined, providers.env),
      callbackPath: (p) => `/${ROUTE_PREFIX}/${encodeURIComponent(p)}/callback`,
      linker: DI.RootContainer.hasRegistered(OidcAccountLinks) ? await DI.resolve(OidcAccountLinks) : null,
      links: DI.RootContainer.hasRegistered(IdentityLinkStore) ? await DI.resolve(IdentityLinkStore) : null,
      log: { warn: (m) => this.Log?.warn(m), error: (m) => this.Log?.error(m) },
    });
    return this.flow;
  }
}
