import type * as express from 'express';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn-session/register-schema';
import { AuthnService, IdentityLinkStore, NonceStore, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, SessionHandle } from '@spinajs/authn/contracts';
import { AuthnSession, proxyTrustOf, publicOriginOf } from '@spinajs/authn-http';
import { sessionCookie } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { BaseController, BasePath, Body, CsrfExempt, Del, Get, Header, OnError, Param, Post, Response, Unauthorized, _setCoockies, _setHeaders, isTrustedPeer } from '@spinajs/http';
import type { ErrorContext, ICookie, Request, ResponseFunction } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Hooks } from '@spinajs/hooks';
import { ValidationFailed } from '@spinajs/validation';

import { OidcLogin } from '../login.js';
import { OIDC_LOGOUT_INVALID, OidcBackchannelLogout } from '../token/logout-token.js';
import type { OidcAnswer, OidcRequest } from '../login.js';
import { OidcAccountLinks } from '../links.js';
import { OidcProviders } from '../providers.js';
import { OIDC_ORIGIN_HEADER_MAX, checkedRequestOrigin } from '../origin.js';
import { isRelaxedEnv } from '../support.js';
import { flowCookieName } from '../flow/cookie.js';
import { OidcBeginQuery, OidcCallbackQueryDto, OidcUnlinkQuery, oidcHeader, oidcProviderParam } from '../dto.js';
import type { BackchannelForm } from '../dto.js';
import { Connection, QueryObject } from '../args.js';
import type { OidcConnection } from '../args.js';

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

const isNavigation = (fetchMode: string | undefined, accept: string | undefined): boolean => fetchMode === 'navigate' || /\btext\/html\b/i.test(accept ?? '');

/** The first value of `name` in a Cookie header, as cookie-parser takes it. */
function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const isForm = (contentType: string | undefined): boolean => (contentType ?? '').split(';')[0].trim().toLowerCase() === FORM;

/** What the routes read from decorated arguments. */
interface RequestFacts {
  readonly query?: object;
  readonly cookie?: string;
  readonly userAgent?: string;
  readonly host?: string;
  readonly forwardedProto?: string;
  readonly forwardedHost?: string;
  readonly fetchMode?: string;
  readonly fetchSite?: string;
  readonly accept?: string;
  readonly connection: OidcConnection;
  readonly session: SessionHandle | null;
}

const PROVIDER = oidcProviderParam;
const HEADER = oidcHeader();
const HOST = oidcHeader(OIDC_ORIGIN_HEADER_MAX);

/**
 * Input that fails validation answers as the login's failure does (303 to the failure page for a navigation, 401
 * otherwise, flow cookie cleared), not with the validator's 400.
 */
const refuseInput = (_err: Error, ctx: ErrorContext) => (ctx.controller as OidcController).refuseInput(ctx.req);

/**
 * `GET /auth/oidc/:provider`, `GET /auth/oidc/:provider/callback`, the link routes `POST` / `DELETE
 * /auth/oidc/:provider/link` (design §22.15), and `POST /auth/oidc/:provider/backchannel-logout`, which the IdP calls
 * server to server, so it is `@CsrfExempt()`. The logic lives in OidcLogin; this maps express to it. The restored
 * session comes from authn-http's middleware (`req.storage.AuthnSession`).
 */
@BasePath(ROUTE_PREFIX)
@OnError([ValidationFailed, InvalidArgument], refuseInput, { stages: ['arguments'] })
export class OidcController extends BaseController {
  @Logger('authn-oidc')
  protected Log: Log;

  protected flow: Promise<OidcLogin> | undefined;
  protected logout: OidcBackchannelLogout | undefined;
  protected peerTrusted: ((peer: string | undefined) => boolean) | undefined;
  protected warnedHttpOrigin = false;
  protected warnedFlowCookieHost = false;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  @Config('authn.http.publicOrigin')
  protected PublicOrigin: string | null | undefined;

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
  public async begin(
    @Param(PROVIDER) provider: string,
    @QueryObject() query: OidcBeginQuery,
    @AuthnSession() session: SessionHandle | null,
    @Connection() connection: OidcConnection,
    @Header('user-agent', HEADER) userAgent?: string,
    @Header('host', HOST) host?: string,
    @Header('x-forwarded-proto', HOST) forwardedProto?: string,
    @Header('x-forwarded-host', HOST) forwardedHost?: string,
    @Header('sec-fetch-mode', HEADER) fetchMode?: string,
    @Header('sec-fetch-site', HEADER) fetchSite?: string,
    @Header('accept', HEADER) accept?: string,
  ) {
    const login = await this.login();
    const facts = { session, connection, userAgent, host, forwardedProto, forwardedHost, fetchMode, fetchSite, accept, query };
    this.warnFlowCookieHost(provider, facts);
    return new OidcResponse(await login.begin(provider, this.requestOf(facts)));
  }

  @Get(':provider/callback')
  public async callback(
    @Param(PROVIDER) provider: string,
    @QueryObject() query: OidcCallbackQueryDto,
    @AuthnSession() session: SessionHandle | null,
    @Connection() connection: OidcConnection,
    @Header('cookie', HEADER) cookie?: string,
    @Header('user-agent', HEADER) userAgent?: string,
    @Header('host', HOST) host?: string,
    @Header('x-forwarded-proto', HOST) forwardedProto?: string,
    @Header('x-forwarded-host', HOST) forwardedHost?: string,
    @Header('sec-fetch-mode', HEADER) fetchMode?: string,
    @Header('sec-fetch-site', HEADER) fetchSite?: string,
    @Header('accept', HEADER) accept?: string,
  ) {
    const login = await this.login();
    return new OidcResponse(await login.callback(provider, this.requestOf({ session, connection, userAgent, host, forwardedProto, forwardedHost, fetchMode, fetchSite, accept, query, cookie })));
  }

  @Post(':provider/link')
  public async beginLink(
    @Param(PROVIDER) provider: string,
    @AuthnSession() session: SessionHandle | null,
    @Connection() connection: OidcConnection,
    @Header('user-agent', HEADER) userAgent?: string,
    @Header('host', HOST) host?: string,
    @Header('x-forwarded-proto', HOST) forwardedProto?: string,
    @Header('x-forwarded-host', HOST) forwardedHost?: string,
    @Header('sec-fetch-mode', HEADER) fetchMode?: string,
    @Header('sec-fetch-site', HEADER) fetchSite?: string,
    @Header('accept', HEADER) accept?: string,
  ) {
    const login = await this.login();
    const facts = { session, connection, userAgent, host, forwardedProto, forwardedHost, fetchMode, fetchSite, accept };
    this.warnFlowCookieHost(provider, facts);
    return new OidcResponse(await login.beginLink(provider, this.requestOf(facts)));
  }

  @Del(':provider/link')
  public async unlink(
    @Param(PROVIDER) provider: string,
    @QueryObject() query: OidcUnlinkQuery,
    @AuthnSession() session: SessionHandle | null,
    @Connection() connection: OidcConnection,
    @Header('user-agent', HEADER) userAgent?: string,
    @Header('host', HOST) host?: string,
    @Header('x-forwarded-proto', HOST) forwardedProto?: string,
    @Header('x-forwarded-host', HOST) forwardedHost?: string,
    @Header('sec-fetch-mode', HEADER) fetchMode?: string,
    @Header('sec-fetch-site', HEADER) fetchSite?: string,
    @Header('accept', HEADER) accept?: string,
  ) {
    const login = await this.login();
    return new OidcResponse(await login.unlink(provider, this.requestOf({ session, connection, userAgent, host, forwardedProto, forwardedHost, fetchMode, fetchSite, accept, query })));
  }

  @CsrfExempt()
  @OnError([ValidationFailed, InvalidArgument], () => new OidcResponse(OIDC_LOGOUT_INVALID), { stages: ['arguments'] })
  @Post(':provider/backchannel-logout')
  public async backchannelLogout(
    @Param(PROVIDER) provider: string,
    @Connection() connection: OidcConnection,
    @Header('content-type', oidcHeader(256)) contentType?: string,
    @Body() logoutForm?: BackchannelForm,
    @Header('user-agent', HEADER) userAgent?: string,
  ): Promise<OidcResponse> {
    this.logout ??= new OidcBackchannelLogout({
      strategies: this.Providers.strategies(),
      sessions: this.Sessions,
      links: this.Links ?? null,
      nonces: this.Nonces,
      log: { warn: (...args: unknown[]) => this.Log?.warn(...(args as Parameters<Log['warn']>)) },
      hooks: this.Hooks,
    });
    // Section 2.5: the token comes form-encoded only.
    const form = isForm(contentType) ? logoutForm : undefined;
    const now = new Date();
    return new OidcResponse(await this.logout.receive(provider, form, now, { ...this.contextOf({ connection, userAgent }, now), purpose: 'request' }));
  }

  /** Re-authenticates the current session at the provider; the callback refreshes its authenticatedAt (FreshAuth). */
  @Get(':provider/reauth')
  public async reauth(
    @Param(PROVIDER) provider: string,
    @QueryObject() query: OidcBeginQuery,
    @AuthnSession() session: SessionHandle | null,
    @Connection() connection: OidcConnection,
    @Header('user-agent', HEADER) userAgent?: string,
    @Header('host', HOST) host?: string,
    @Header('x-forwarded-proto', HOST) forwardedProto?: string,
    @Header('x-forwarded-host', HOST) forwardedHost?: string,
    @Header('sec-fetch-mode', HEADER) fetchMode?: string,
    @Header('sec-fetch-site', HEADER) fetchSite?: string,
    @Header('accept', HEADER) accept?: string,
  ) {
    const login = await this.login();
    const facts = { session, connection, userAgent, host, forwardedProto, forwardedHost, fetchMode, fetchSite, accept, query };
    this.warnFlowCookieHost(provider, facts);
    return new OidcResponse(await login.beginReauth(provider, this.requestOf(facts)));
  }

  /** The answer to input that failed validation; public for the class-level `@OnError`. */
  public async refuseInput(req: Request): Promise<OidcResponse> {
    const login = await this.login();
    return new OidcResponse(login.failure({ navigation: isNavigation(req.get('sec-fetch-mode'), req.get('accept')) }));
  }

  protected contextOf(f: Pick<RequestFacts, 'connection' | 'userAgent'>, now: Date): AuthnContext {
    return { now, purpose: 'login', ...(f.connection.clientIp ? { ip: f.connection.clientIp } : {}), ...(f.userAgent ? { userAgent: f.userAgent } : {}) };
  }

  protected requestOf(f: RequestFacts): OidcRequest {
    const ctx = this.contextOf(f, new Date());
    const flowName = flowCookieName(this.env);
    const flow = cookieOf(f.cookie, flowName);
    return {
      origin: this.originOf(f),
      cookies: flow === undefined ? {} : { [flowName]: flow },
      query: { ...f.query },
      navigation: isNavigation(f.fetchMode, f.accept),
      ctx,
      session: f.session,
      ...(f.fetchSite ? { fetchSite: f.fetchSite } : {}),
    };
  }

  /** `authn.http.publicOrigin` when set; else the request's origin, undefined when it is no valid origin. */
  protected originOf(f: RequestFacts): string | undefined {
    const configured = publicOriginOf(this.PublicOrigin);
    const origin = configured ?? this.checkedOriginOf(f);
    if (origin === undefined) return undefined;
    if (!this.warnedHttpOrigin && origin.startsWith('http:') && !isRelaxedEnv(this.env)) {
      this.warnedHttpOrigin = true;
      this.Log?.warn(
        configured === undefined
          ? 'authn-oidc: the default redirect_uri has an http origin; set authn.http.publicOrigin, or behind a TLS proxy authn.http.trustProxy (or http.trustProxy), or the provider redirectUri'
          : 'authn-oidc: authn.http.publicOrigin is an http origin, and so is the default redirect_uri; set it to the https origin the browser uses',
      );
    }
    return origin;
  }

  protected checkedOriginOf(f: RequestFacts): string | undefined {
    return checkedRequestOrigin({ encrypted: f.connection.encrypted, peer: f.connection.peer, host: f.host, forwardedProto: f.forwardedProto, forwardedHost: f.forwardedHost }, this.trusted);
  }

  /**
   * Once per process, at a flow start: the flow cookie is host-only, so a flow started on another host than
   * `authn.http.publicOrigin`, where the default redirect_uri points, reaches its callback without it and fails.
   */
  protected warnFlowCookieHost(provider: string, f: RequestFacts): void {
    if (this.warnedFlowCookieHost) return;
    const configured = publicOriginOf(this.PublicOrigin);
    if (configured === undefined || this.Providers.strategies().get(provider)?.provider.options.redirectUri !== null) return;
    const origin = this.checkedOriginOf(f);
    // Cookies ignore scheme and port, so only the host decides whether the callback gets the cookie.
    if (origin === undefined || new URL(origin).hostname === new URL(configured).hostname) return;
    this.warnedFlowCookieHost = true;
    this.Log?.warn(
      { provider, origin, publicOrigin: configured },
      'authn-oidc: a ${provider} flow started on ${origin}, but its redirect_uri is on authn.http.publicOrigin ${publicOrigin}; the flow cookie is host-only, so the callback arrives without it and the login fails. Serve the app on publicOrigin only, have a trusted proxy send X-Forwarded-Host, or set authn.oidc.providers.${provider}.redirectUri',
    );
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
