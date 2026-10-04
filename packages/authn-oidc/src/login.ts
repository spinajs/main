import type { AuthenticationResult, AuthnContext, AuthnEvent, AuthnService, Credentials, ExternalLoginHook, IdentityLinkStore, IdentityRef, SessionHandle, SessionIssuer } from '@spinajs/authn/contracts';

import type { OidcAppPath } from './contracts.js';
import { clearFlowCookie, decodeFlow, flowCookie, flowCookieName, flowSecrets, sessionBindingOf } from './flow/cookie.js';
import type { OidcAccountLinks } from './links.js';
import type { FlowCookie } from './flow/cookie.js';
import type { OidcCallbackQuery } from './provider.js';
import type { OidcCallbackPayload, OidcStrategy } from './strategy.js';

/** The A02 answer, byte-equal to the login route's 401 body. */
export const OIDC_FAILURE_BODY = Object.freeze({ error: Object.freeze({ code: 'E_AUTH_FAILED', message: 'login or password incorrect' }) });

/** What the HTTP layer knows about the request. */
export interface OidcRequest {
  /** The app's origin as the client sees it (scheme://host[:port]), from the trusted-proxy chain. */
  readonly origin: string;
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, unknown>>;
  /** A browser navigation (Sec-Fetch-Mode: navigate, or Accept lists text/html): failures redirect instead of 401. */
  readonly navigation: boolean;
  readonly ctx: AuthnContext;
  /** The session the request restored (authn-http's AuthnSession), pending included; link routes need an active one. */
  readonly session?: SessionHandle | null;
  /** The Sec-Fetch-Site request header, when the browser sent one. */
  readonly fetchSite?: string;
}

/** Framework-free HTTP answer the controller maps to a response. */
export interface OidcAnswer {
  readonly status: number;
  readonly location?: string;
  readonly cookies: readonly FlowCookie[];
  /** JSON body. */
  readonly body?: unknown;
  /** An HTML page instead (status 200), sent with Cache-Control: no-store. */
  readonly html?: string;
  /** Lower-case names, e.g. retry-after of a throttled login (A02). */
  readonly headers?: Readonly<Record<string, string>>;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A page that moves the browser on to an app path. The callback arrives by a cross-site navigation, and browsers keep
 * a whole redirect chain cross-site, so a SameSite=Strict session cookie set or needed there would not travel on a 303;
 * a navigation started by this same-site page carries it.
 */
function refreshPage(target: string): string {
  const t = escapeHtml(target);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${t}"><title>Signing in</title></head><body><a href="${t}">Continue</a></body></html>`;
}

export interface OidcLoginDeps {
  readonly strategies: ReadonlyMap<string, OidcStrategy>;
  readonly service: AuthnService;
  readonly sessions: SessionIssuer;
  /** Read per login, so hooks registered late still run. */
  readonly hooks: () => readonly ExternalLoginHook[];
  readonly redirects: { readonly success: OidcAppPath; readonly failure: OidcAppPath };
  readonly env: string | undefined;
  /** The session cookie for a handle the service issued (authn-http's cookie rules). */
  readonly sessionCookie: (handle: SessionHandle) => FlowCookie;
  /** The callback route path of a provider, e.g. '/auth/oidc/corp/callback'. */
  readonly callbackPath: (provider: string) => string;
  readonly log?: { warn(message: string): void; error(message: string): void };
  /** Link routes answer 404 without it (D16). */
  readonly linker?: OidcAccountLinks | null;
  /** Finds the link a DELETE names by provider. */
  readonly links?: IdentityLinkStore | null;
  /**
   * Audit (the core's AuthnAudit). The core audits the login before the hooks run, so a login the hooks refuse gets
   * its own failure event; without it the audit trail would show only the success.
   */
  readonly audit?: (e: AuthnEvent) => Promise<void>;
}

/** An answer without a body that says nothing about why: the link routes' refusals. */
const NOT_FOUND: Omit<OidcAnswer, 'cookies'> = { status: 404 };
const REFUSED_BODY = Object.freeze({ error: Object.freeze({ code: 'E_LINK_REFUSED' }) });

const QUERY_KEYS = ['code', 'state', 'iss', 'error'] as const;
const MAX_QUERY_VALUE = 4096;

function callbackQueryOf(q: Readonly<Record<string, unknown>>): OidcCallbackQuery | null {
  const out: Record<string, string> = {};
  for (const k of QUERY_KEYS) {
    const v = q[k];
    if (v === undefined) continue;
    // A repeated parameter arrives as an array: refuse it rather than pick one.
    if (typeof v !== 'string' || v.length > MAX_QUERY_VALUE) return null;
    out[k] = v;
  }
  return out;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * The login routes without a framework: `GET /auth/oidc/:provider` starts a flow, `/callback` completes it through
 * AuthnService and fans the mapped subject out to every ExternalLoginHook (D6). Every failure is one answer (D3).
 */
export class OidcLogin {
  constructor(protected readonly d: OidcLoginDeps) {}

  public async begin(provider: string, req: OidcRequest): Promise<OidcAnswer> {
    const strategy = this.d.strategies.get(provider);
    if (!strategy) return this.failure(req);
    try {
      const { flow, location } = await strategy.provider.begin({ redirectUri: `${req.origin}${this.d.callbackPath(provider)}`, returnTo: req.query.returnTo, mode: 'login', now: req.ctx.now });
      return { status: 302, location, cookies: [flowCookie(flow, this.d.env)] };
    } catch (err) {
      this.d.log?.warn(`authn-oidc: could not start a login with provider ${provider}: ${errorName(err)}`);
      return this.failure(req);
    }
  }

  public async callback(provider: string, req: OidcRequest): Promise<OidcAnswer> {
    const strategy = this.d.strategies.get(provider);
    const flow = req.cookies[flowCookieName(this.d.env)];
    const query = callbackQueryOf(req.query);
    if (!strategy || typeof flow !== 'string' || query === null) return this.failure(req);

    const payload: OidcCallbackPayload = { flow, query };
    const credentials: Credentials = { kind: 'external', provider: strategy.name, payload: payload as unknown as Record<string, unknown> };
    if (decodeFlow(flow)?.m === 'link') {
      return this.linkCallback(strategy, credentials, req);
    }
    let result: AuthenticationResult;
    try {
      result = await this.d.service.authenticate(credentials, { ...req.ctx, purpose: 'login' });
    } catch (err) {
      this.d.log?.error(`authn-oidc: the login with provider ${provider} failed unexpectedly: ${errorName(err)}`);
      return this.failure(req);
    }
    if (result.status === 'failure') return this.failure(req, result.retryAfterSeconds);

    const handle = result.status === 'success' ? result.session : result.pending;
    if (!handle) {
      // An interactive strategy always gets a session from the core; without one the browser could not stay logged in.
      return this.failure(req);
    }
    let ok = false;
    let identity: IdentityRef | null = null;
    let reason = 'hook_error';
    try {
      identity = await this.identityOf(result, handle);
      const external = strategy.verified(credentials);
      if (identity === null || external === undefined) {
        reason = identity === null ? 'no_identity' : 'no_verified_subject';
        this.d.log?.error(`authn-oidc: the login with provider ${provider} lost its ${reason === 'no_identity' ? 'identity' : 'verified subject'} after authentication`);
      } else {
        ok = await this.runHooks(identity, external);
      }
    } catch (err) {
      this.d.log?.error(`authn-oidc: the login with provider ${provider} failed after authentication: ${errorName(err)}`);
    }
    if (!ok) {
      await this.d.sessions.revoke(handle).catch((err: unknown) => this.d.log?.error(`authn-oidc: could not revoke the session of a refused login: ${errorName(err)}`));
      await this.d
        .audit?.({ type: 'login', outcome: 'failure', at: req.ctx.now, strategy: strategy.name, reason, ...(identity ? { identity } : {}), ...(req.ctx.ip ? { ip: req.ctx.ip } : {}), ...(req.ctx.userAgent ? { userAgent: req.ctx.userAgent } : {}) })
        .catch(() => undefined);
      return this.failure(req);
    }
    const returnTo = decodeFlow(flow)?.r ?? this.d.redirects.success;
    return this.moveOn(req, returnTo, [clearFlowCookie(this.d.env), this.d.sessionCookie(handle)]);
  }

  /**
   * `POST /auth/oidc/:provider/link`: starts a flow bound to the current active session (D16). A POST, so authn-http's
   * origin check (A22) guards it; a cross-site start would let another site link its own account to this session's
   * identity (account-linking CSRF), whatever SameSite the session cookie has.
   */
  public async beginLink(provider: string, req: OidcRequest): Promise<OidcAnswer> {
    const strategy = this.d.strategies.get(provider);
    if (!strategy || !this.d.linker) return { ...NOT_FOUND, cookies: [] };
    const session = req.session;
    if (!session || session.state !== 'active') return this.failure(req);
    if (req.fetchSite !== undefined && req.fetchSite !== 'same-origin' && req.fetchSite !== 'none') return this.failure(req);
    try {
      const { flow, location } = await strategy.provider.begin({ redirectUri: `${req.origin}${this.d.callbackPath(provider)}`, mode: 'link', sessionHash: sessionBindingOf(session.id), now: req.ctx.now });
      return { status: 302, location, cookies: [flowCookie(flow, this.d.env)] };
    } catch (err) {
      this.d.log?.warn(`authn-oidc: could not start linking with provider ${provider}: ${errorName(err)}`);
      return this.failure(req);
    }
  }

  /** A link flow's callback: the same session must come back, then the link service decides (fresh auth, A19). */
  protected async linkCallback(strategy: OidcStrategy, credentials: Credentials, req: OidcRequest): Promise<OidcAnswer> {
    const session = req.session;
    const flow = decodeFlow((credentials as { payload?: { flow?: unknown } }).payload?.flow);
    const ours = flow !== null && typeof req.query.state === 'string' && req.query.state === flowSecrets(flow).state;
    if (!session && this.d.linker && ours && req.navigation && req.query.bounce === undefined) {
      // The Strict session cookie did not come with the cross-site arrival; one same-site hop brings it (nothing consumed yet).
      const again = new URLSearchParams();
      for (const k of QUERY_KEYS) {
        const v = req.query[k];
        if (typeof v === 'string') again.set(k, v);
      }
      again.set('bounce', '1');
      return { status: 200, cookies: [], html: refreshPage(`${this.d.callbackPath(strategy.provider.name)}?${again.toString()}`) };
    }
    if (!this.d.linker || !session || session.state !== 'active') return this.failure(req);
    const ctx: AuthnContext = { ...req.ctx, purpose: 'link', session };
    try {
      const external = await strategy.verifyLink(credentials, sessionBindingOf(session.id), ctx);
      const linked = await this.d.linker.link(session, external, ctx);
      if (!linked.ok) return this.failure(req);
    } catch (err) {
      this.d.log?.warn(`authn-oidc: linking with ${strategy.name} failed: ${errorName(err)}`);
      return this.failure(req);
    }
    return this.moveOn(req, this.d.redirects.success, [clearFlowCookie(this.d.env)]);
  }

  /** Success: a browser gets the same-site refresh page, any other client a 303. */
  protected moveOn(req: OidcRequest, target: string, cookies: readonly FlowCookie[]): OidcAnswer {
    return req.navigation ? { status: 200, cookies, html: refreshPage(target) } : { status: 303, location: target, cookies };
  }

  /** `DELETE /auth/oidc/:provider/link`: removes the current identity's link of this provider unless it is the last credential. */
  public async unlink(provider: string, req: OidcRequest): Promise<OidcAnswer> {
    const strategy = this.d.strategies.get(provider);
    if (!strategy || !this.d.linker || !this.d.links) return { ...NOT_FOUND, cookies: [] };
    const session = req.session;
    const restored = session && session.state === 'active' ? await this.d.sessions.restore(session.id) : null;
    if (!session || !restored) return { status: 401, cookies: [], body: OIDC_FAILURE_BODY };
    try {
      const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
      const mine = (await this.d.links.list(restored.identity)).filter((l) => l.provider === strategy.name && (subject === undefined || l.subject === subject));
      if (mine.length === 0) return { ...NOT_FOUND, cookies: [] };
      // Several subjects of one provider: the caller names the one to remove.
      if (mine.length > 1) return { status: 409, cookies: [], body: REFUSED_BODY };
      const out = await this.d.linker.unlink(session, mine[0].id, { ...req.ctx, purpose: 'link', session });
      return out.ok ? { status: 204, cookies: [] } : { status: 403, cookies: [], body: REFUSED_BODY };
    } catch (err) {
      this.d.log?.error(`authn-oidc: unlinking ${strategy.name} failed: ${errorName(err)}`);
      return { status: 403, cookies: [], body: REFUSED_BODY };
    }
  }

  protected async identityOf(result: AuthenticationResult, handle: SessionHandle): Promise<IdentityRef | null> {
    if (result.status === 'success') return result.identity;
    return (await this.d.sessions.restore(handle.id))?.identity ?? null;
  }

  /** A throwing hook fails the login (design §22.15), so hooks must be idempotent. */
  protected async runHooks(identity: IdentityRef, external: Parameters<ExternalLoginHook['afterLogin']>[1]): Promise<boolean> {
    for (const hook of this.d.hooks()) {
      try {
        await hook.afterLogin(identity, external);
      } catch (err) {
        this.d.log?.error(`authn-oidc: an ExternalLoginHook failed the login of ${external.provider}: ${errorName(err)}`);
        return false;
      }
    }
    return true;
  }

  /** D3: one answer for every failure; a browser goes to the failure page with no reason in the URL. */
  public failure(req: Pick<OidcRequest, 'navigation'>, retryAfterSeconds?: number): OidcAnswer {
    const cookies = [clearFlowCookie(this.d.env)];
    const headers = retryAfterSeconds !== undefined ? { headers: { 'retry-after': String(retryAfterSeconds) } } : {};
    return req.navigation ? { status: 303, location: this.d.redirects.failure, cookies, ...headers } : { status: 401, cookies, body: OIDC_FAILURE_BODY, ...headers };
  }
}
