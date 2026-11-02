import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn-http/register-schema';
import type { Session } from '@spinajs/authn/contracts';
import { AuthnLogoutExtension, proxyTrustOf, publicOriginOf } from '@spinajs/authn-http';
import { isTrustedPeer } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { OIDC_ID_TOKEN_KEY } from './id-token-key.js';
import { checkedRequestOrigin } from './origin.js';
import { OidcProviders } from './providers.js';
import type { OidcStrategy } from './strategy.js';

export { OIDC_ID_TOKEN_KEY };

/** `logout.postLogoutRedirectUri`, else `/` on the origin of the provider's `redirectUri`, else on `origin`. */
function postLogoutRedirectOf(options: { readonly logout: { readonly postLogoutRedirectUri: string | null }; readonly redirectUri: string | null }, origin: string | undefined): string | undefined {
  if (options.logout.postLogoutRedirectUri !== null) return options.logout.postLogoutRedirectUri;
  // The registered redirectUri names the app's origin; the request's comes from Host, which the client chooses.
  const base = options.redirectUri === null ? origin : new URL(options.redirectUri).origin;
  return base === undefined ? undefined : `${base}/`;
}

/**
 * The RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0) of an OIDC session, without a framework: the
 * end_session_endpoint URL that ends the identity provider's session, or undefined when there is none to end.
 */
export class OidcRpLogout {
  constructor(
    protected readonly strategies: ReadonlyMap<string, OidcStrategy>,
    protected readonly log?: Pick<Log, 'warn'>,
  ) {}

  /**
   * @param origin - the app's origin as the client sees it, for the default post_logout_redirect_uri of a provider
   * without `redirectUri`; a provider with one takes the origin of its `redirectUri`. Without either (and without the
   * provider's `logout.postLogoutRedirectUri`) the URL has no post_logout_redirect_uri: the provider still ends its
   * session and shows its own page.
   */
  public async endSessionUrl(session: Session, origin: string | undefined, now: Date = new Date()): Promise<string | undefined> {
    const external = session.facts.external;
    const strategy = external === undefined ? undefined : [...this.strategies.values()].find((s) => s.name === external.provider);
    const discovery = strategy?.provider.discovery;
    if (strategy === undefined || external === undefined || discovery === null || discovery === undefined) return undefined;

    let endpoint: string | undefined;
    try {
      endpoint = (await discovery.metadata(now.getTime())).end_session_endpoint;
    } catch (err) {
      this.log?.warn({ provider: strategy.name, errorName: err instanceof Error ? err.name : typeof err }, 'authn-oidc: no logout redirect for ${provider}, its discovery failed: ${errorName}');
      return undefined;
    }
    if (endpoint === undefined) return undefined;

    const url = new URL(endpoint);
    url.searchParams.set('client_id', strategy.provider.options.clientId);
    const postLogout = postLogoutRedirectOf(strategy.provider.options, origin);
    if (postLogout !== undefined) url.searchParams.set('post_logout_redirect_uri', postLogout);
    if (external.sid !== undefined) url.searchParams.set('logout_hint', external.sid);
    const idToken = session.get(OIDC_ID_TOKEN_KEY);
    if (idToken !== undefined) url.searchParams.set('id_token_hint', idToken);
    return url.toString();
  }
}

/** Sends the browser to the provider's end_session_endpoint after `POST /auth/logout` revoked an OIDC session. */
@Injectable(AuthnLogoutExtension)
export class OidcLogoutExtension extends AuthnLogoutExtension {
  @Logger('authn-oidc')
  protected Log: Log;

  @Autoinject(OidcProviders)
  protected Providers: OidcProviders;

  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  @Config('authn.http.publicOrigin')
  protected PublicOrigin: string | null | undefined;

  public async afterLogout(session: Session, req: Request): Promise<{ readonly redirect?: string } | void> {
    // The session is already revoked: a logger that cannot be built must not fail the logout.
    const log = {
      warn: (...args: unknown[]) => {
        try {
          this.Log.warn(...(args as Parameters<Log['warn']>));
        } catch {
          // best effort
        }
      },
    };
    const url = await new OidcRpLogout(this.Providers.strategies(), log).endSessionUrl(session, this.originOf(req));
    return url === undefined ? undefined : { redirect: url };
  }

  /** `authn.http.publicOrigin` when set; else the request's origin, undefined when it is no valid origin. */
  protected originOf(req: Request): string | undefined {
    const configured = publicOriginOf(this.PublicOrigin);
    if (configured !== undefined) return configured;

    const socket = req.socket as { encrypted?: boolean; remoteAddress?: string };
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    return checkedRequestOrigin(
      { encrypted: socket.encrypted === true, peer: socket.remoteAddress, host: req.get('host'), forwardedProto: req.get('x-forwarded-proto'), forwardedHost: req.get('x-forwarded-host') },
      (peer) => isTrustedPeer(trust, peer),
    );
  }
}
