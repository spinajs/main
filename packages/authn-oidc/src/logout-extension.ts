import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { sessionKey } from '@spinajs/authn/contracts';
import type { Session } from '@spinajs/authn/contracts';
import { AuthnLogoutExtension } from '@spinajs/authn-http';
import type { Request } from '@spinajs/http';

import type { OidcStrategy } from './strategy.js';
import { OidcProviders } from './providers.js';
import { isNonEmptyString } from './support.js';

/** The validated ID token of an OIDC login, kept only for a provider with `logout.storeIdToken`. */
export const OIDC_ID_TOKEN_KEY = sessionKey('OidcIdToken', (raw: unknown): string | undefined => (isNonEmptyString(raw) ? raw : undefined));

/**
 * The RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0) of an OIDC session, without a framework: the
 * end_session_endpoint URL that ends the identity provider's session, or undefined when there is none to end.
 */
export class OidcRpLogout {
  constructor(protected readonly strategies: ReadonlyMap<string, OidcStrategy>) {}

  /** @param origin - the app's origin as the client sees it, for the default post_logout_redirect_uri */
  public async endSessionUrl(_session: Session, _origin: string, _now: Date = new Date()): Promise<string | undefined> {
    throw new Error('not implemented: OidcRpLogout.endSessionUrl');
  }
}

/** Sends the browser to the provider's end_session_endpoint after `POST /auth/logout` revoked an OIDC session. */
@Injectable(AuthnLogoutExtension)
export class OidcLogoutExtension extends AuthnLogoutExtension {
  @Autoinject(OidcProviders)
  protected Providers: OidcProviders;

  @Config('authn.http.trustProxy')
  protected OwnTrust: unknown;

  @Config('http.trustProxy')
  protected SharedTrust: unknown;

  public async afterLogout(_session: Session, _req: Request): Promise<{ readonly redirect?: string } | void> {
    throw new Error('not implemented: OidcLogoutExtension.afterLogout');
  }
}
