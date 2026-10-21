import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { Session } from '@spinajs/authn/contracts';
import { AuthnLogoutExtension, proxyTrustOf } from '@spinajs/authn-http';
import { isTrustedPeer } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { OIDC_ID_TOKEN_KEY } from './id-token-key.js';
import { requestOrigin } from './origin.js';
import { OidcProviders } from './providers.js';
import type { OidcStrategy } from './strategy.js';

export { OIDC_ID_TOKEN_KEY };

/**
 * The RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0) of an OIDC session, without a framework: the
 * end_session_endpoint URL that ends the identity provider's session, or undefined when there is none to end.
 */
export class OidcRpLogout {
  constructor(
    protected readonly strategies: ReadonlyMap<string, OidcStrategy>,
    protected readonly log?: Pick<Log, 'warn'>,
  ) {}

  /** @param origin - the app's origin as the client sees it, for the default post_logout_redirect_uri */
  public async endSessionUrl(session: Session, origin: string, now: Date = new Date()): Promise<string | undefined> {
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

    const { clientId, logout } = strategy.provider.options;
    const url = new URL(endpoint);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('post_logout_redirect_uri', logout.postLogoutRedirectUri ?? `${origin}/`);
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

  protected originOf(req: Request): string {
    const socket = req.socket as { encrypted?: boolean; remoteAddress?: string };
    const trust = proxyTrustOf(this.OwnTrust, this.SharedTrust);
    return requestOrigin(
      { encrypted: socket.encrypted === true, peer: socket.remoteAddress, host: req.get('host'), forwardedProto: req.get('x-forwarded-proto'), forwardedHost: req.get('x-forwarded-host') },
      (peer) => isTrustedPeer(trust, peer),
    );
  }
}
