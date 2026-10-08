import * as cs from 'cookie-signature';
import { Autoinject, Container, DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Log, Logger } from '@spinajs/log';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, Principal } from '@spinajs/authn/contracts';
import { appEnvOf, assertSessionCookieSecret, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { SocketPrincipalSource } from '@spinajs/http-socket';
import type { ISocketHandshake } from '@spinajs/http-socket';

import { SessionPrincipalResolver } from '../resolvers/session.js';

/**
 * The browser session cookie as a socket principal: AuthnMiddleware's restore and SessionPrincipalResolver for a handshake.
 * Order 40, before AuthnCredentialSource ( 50 ): an active session wins over bearer credentials, as in http. A pending
 * session, or an unknown, ended or forged cookie, gives null, so a bearer token is still tried ( SR-07 ). http-socket
 * refuses a cross-site handshake before any source runs ( SR-12 ). Revalidation restores the session again, so logout,
 * revocation or an id rotation closes the socket.
 */
@Injectable(SocketPrincipalSource)
export class SessionSocketPrincipalSource extends SocketPrincipalSource {
  public readonly name = 'session';
  public readonly order = 40;

  @Autoinject(Container)
  protected Container!: IContainer;

  // appEnvOf reads the Configuration's Env for the SR-16 "no env named" rule, which @Config cannot give
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Config('http.cookie.secret')
  protected CookieSecret: string;

  @Config('authn.session.cookie')
  protected SessionCookie: ISessionCookieConfig | undefined;

  @Logger('authn-http')
  protected Log!: Log;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    // inert until the 3.0 session layer is registered, as AuthnCredentialSource is without an AuthnService
    if (!DI.check(SessionIssuer)) {
      return null;
    }

    const rawId = this.sessionId(handshake);
    if (rawId === null) {
      return null;
    }

    const session = await (await this.Container.resolve(SessionIssuer)).restore(rawId);
    if (!session) {
      return null;
    }

    const resolver = await this.Container.resolve(SessionPrincipalResolver);
    return resolver.principalOfSession(session, this.context(handshake));
  }

  /** The raw session id from the signed cookie; null when it is absent, unsigned or forged. */
  protected sessionId(handshake: ISocketHandshake): string | null {
    const env = appEnvOf(this.Configuration);
    const value = handshake.cookies[sessionCookieName(this.SessionCookie ?? {}, env)];
    if (typeof value !== 'string' || value === '') {
      return null;
    }

    assertSessionCookieSecret(this.CookieSecret, env);
    // @spinajs/http signs by hand ( cs.sign ); express res.cookie({ signed: true }) adds an `s:` prefix
    const id = cs.unsign(value.startsWith('s:') ? value.slice(2) : value, this.CookieSecret);
    if (id === false || id === '') {
      this.Log.warn('Rejected a socket session cookie with an invalid signature', { Ip: handshake.address });
      return null;
    }

    return id;
  }

  protected context(handshake: ISocketHandshake): AuthnContext {
    const userAgent = handshake.headers['user-agent'];
    return { ip: handshake.address, ...(typeof userAgent === 'string' ? { userAgent } : {}), now: new Date(), purpose: 'request' };
  }
}
