import { createHash } from 'node:crypto';
import * as cs from 'cookie-signature';
import { Autoinject, Container, DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { AuthenticationFailed } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, Principal } from '@spinajs/authn/contracts';
import { appEnvOf, assertSessionCookieSecret, peekingSessions, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { AUTHENTICATION_FAILED, SocketPrincipalSource } from '@spinajs/http-socket';
import type { ISocketHandshake, SocketRevalidationResult } from '@spinajs/http-socket';

import { SessionPrincipalResolver } from '../resolvers/session.js';

// http-socket's ISocketRevalidation written out, so this also compiles against an http-socket build that predates it
type SocketRevalidationCheck = { readonly trigger: string; readonly active: boolean };

// AuthnMiddleware's: sha256 of a raw session id is its storage key, which must not reach a log.
const logHash = (value: string): string => createHash('sha256').update(`authn-http:log\0${value}`).digest('hex').slice(0, 16);

/**
 * The browser session cookie as a socket principal: AuthnMiddleware's restore and SessionPrincipalResolver for a handshake.
 * Order 40, before AuthnCredentialSource ( 50 ): an active session wins over bearer credentials, as in http. A pending
 * session, or an unknown, ended or forged cookie, gives null, so a bearer token is still tried ( SR-07 ); an active
 * session that gives no principal refuses the handshake, as http tries no bearer credentials beside it. http-socket
 * refuses a cross-site handshake before any source runs ( SR-12 ). Revalidation reads the session again and slides
 * it only for client activity, so logout, revocation, an id rotation or the idle timeout of an idle socket closes it.
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
      this.Log.warn('Session cookie names no live session (expired or unknown)', { Session: logHash(rawId), Ip: handshake.address });
      return null;
    }

    const resolver = await this.Container.resolve(SessionPrincipalResolver);
    const principal = await resolver.principalOfSession(session, this.context(handshake));
    if (principal === null && session.handle.state === 'active') {
      throw new AuthenticationFailed(AUTHENTICATION_FAILED);
    }

    return principal;
  }

  /**
   * The inherited check. When `check.active` reports a command or an event since the last check ( or a recovery ), the
   * session is restored as an http request restores it, which slides it, up to `http.socket.auth.revalidateMs` after the
   * activity. Otherwise it is only read: sweeps are no user activity, so an idle socket still ends at the idle timeout.
   * Only DefaultSessionIssuer honours `peekingSessions`.
   */
  public revalidate(handshake: ISocketHandshake, principal: Principal, check?: SocketRevalidationCheck): Promise<SocketRevalidationResult> {
    if (check?.active) {
      return super.revalidate(handshake, principal);
    }

    return peekingSessions(() => super.revalidate(handshake, principal));
  }

  /**
   * The raw session id from the signed cookie; null when it is absent, unsigned, forged or empty. Both the raw form
   * (`cs.sign`) and express's `s:` form are verified here with `http.cookie.secret`: the handshake carries raw cookie
   * values, whatever cookie parser the app's http stack uses.
   */
  protected sessionId(handshake: ISocketHandshake): string | null {
    const env = appEnvOf(this.Configuration);
    const value = handshake.cookies[sessionCookieName(this.SessionCookie ?? {}, env)];
    if (typeof value !== 'string' || value === '') {
      return null;
    }

    assertSessionCookieSecret(this.CookieSecret, env);
    const id = cs.unsign(value.startsWith('s:') ? value.slice(2) : value, this.CookieSecret);
    if (id === false) {
      this.Log.warn('Rejected a socket session cookie with an invalid signature', { Cookie: logHash(value), Ip: handshake.address });
      return null;
    }

    return id === '' ? null : id;
  }

  protected context(handshake: ISocketHandshake): AuthnContext {
    const userAgent = handshake.headers['user-agent'];
    return { ip: handshake.address, ...(typeof userAgent === 'string' ? { userAgent } : {}), now: new Date(), purpose: 'request' };
  }
}
