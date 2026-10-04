import type { AuthenticationResult, AuthnContext, AuthnService, Credentials, ExternalLoginHook, IdentityRef, SessionHandle, SessionIssuer } from '@spinajs/authn/contracts';

import type { OidcAppPath } from './contracts.js';
import { clearFlowCookie, decodeFlow, flowCookie, flowCookieName } from './flow/cookie.js';
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
}

/** Framework-free HTTP answer the controller maps to a response. */
export interface OidcAnswer {
  readonly status: number;
  readonly location?: string;
  readonly cookies: readonly FlowCookie[];
  readonly body?: unknown;
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
}

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
    let result: AuthenticationResult;
    try {
      result = await this.d.service.authenticate(credentials, { ...req.ctx, purpose: 'login' });
    } catch (err) {
      this.d.log?.error(`authn-oidc: the login with provider ${provider} failed unexpectedly: ${errorName(err)}`);
      return this.failure(req);
    }
    if (result.status === 'failure') return this.failure(req);

    const handle = result.status === 'success' ? result.session : result.pending;
    if (!handle) {
      // An interactive strategy always gets a session from the core; without one the browser could not stay logged in.
      return this.failure(req);
    }
    const identity = await this.identityOf(result, handle);
    const external = strategy.verified(credentials);
    if (!identity || !external || !(await this.runHooks(identity, external))) {
      await this.d.sessions.revoke(handle).catch(() => undefined);
      return this.failure(req);
    }
    const returnTo = decodeFlow(flow)?.r ?? this.d.redirects.success;
    return { status: 303, location: returnTo, cookies: [clearFlowCookie(this.d.env), this.d.sessionCookie(handle)] };
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
  public failure(req: Pick<OidcRequest, 'navigation'>): OidcAnswer {
    const cookies = [clearFlowCookie(this.d.env)];
    return req.navigation ? { status: 303, location: this.d.redirects.failure, cookies } : { status: 401, cookies, body: OIDC_FAILURE_BODY };
  }
}
