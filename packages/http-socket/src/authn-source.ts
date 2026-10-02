import { DI, Injectable } from '@spinajs/di';
import { AuthnService, CredentialExtractor } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, SignedRequest } from '@spinajs/authn/contracts';
import { Unauthenticated, principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketHandshake, SocketPrincipalSource, SocketRevalidationResult } from './interfaces.js';

/** One answer for every failed attempt, as authn-http gives ( A02 ); the reason goes to authn's audit only. */
export const AUTHENTICATION_FAILED = 'authentication failed';

/**
 * The handshake as authn's `SignedRequest`. Browsers cannot set WebSocket headers, so a token in
 * `auth.token` becomes `Authorization: Bearer`. The Cookie header is left out: a browser sends
 * cookies with a socket opened from any site, so they are no credential here ( SR-12 ).
 */
export function credentialRequest(handshake: ISocketHandshake): SignedRequest {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(handshake.headers)) {
    const key = name.toLowerCase();
    if (key === 'cookie' || value === undefined) {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  const token = handshake.auth.token;
  if (typeof token === 'string' && token.length > 0 && headers.authorization === undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  return { method: 'GET', targetUri: handshake.url, headers };
}

/**
 * Bearer, key and signature credentials through `@spinajs/authn` ( throttled and audited by
 * AuthnService ), at order 50 like authz-http's AuthnPrincipalSource. Inert until an
 * AuthnService is registered.
 */
@Injectable(SocketPrincipalSource)
export class AuthnCredentialSource extends SocketPrincipalSource {
  public readonly name = 'authn';
  public readonly order = 50;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    if (!DI.check(AuthnService)) {
      return null;
    }

    const credentials = await this.extract(credentialRequest(handshake));
    if (!credentials) {
      return null;
    }

    const authn = (await DI.resolve(AuthnService)) as AuthnService;
    const result = await authn.authenticate(credentials, this.context(handshake));

    if (result.status === 'success') {
      return authn.principalOf(result);
    }

    // mfa_required falls through: a login pending MFA is no principal ( SR-07 )
    if (result.status === 'failure' && result.retryAfterSeconds !== undefined) {
      throw new SocketException('unauthenticated', AUTHENTICATION_FAILED, { retryAfterMs: result.retryAfterSeconds * 1000 });
    }

    throw new Unauthenticated(AUTHENTICATION_FAILED);
  }

  /** A rejected, expired or revoked credential is 'invalid'; a throttled attempt or a failing AuthnService is 'unavailable'. */
  public async revalidate(handshake: ISocketHandshake, principal: Principal): Promise<SocketRevalidationResult> {
    try {
      if (!DI.check(AuthnService)) {
        return 'unavailable';
      }

      const credentials = await this.extract(credentialRequest(handshake));
      if (!credentials) {
        return 'invalid';
      }

      const authn = (await DI.resolve(AuthnService)) as AuthnService;
      const result = await authn.authenticate(credentials, this.context(handshake));

      if (result.status === 'success') {
        const again = await authn.principalOf(result);
        return principalKey(again) === principalKey(principal) ? { status: 'valid', principal: again } : 'invalid';
      }

      return result.status === 'failure' && result.reason === 'throttled' ? 'unavailable' : 'invalid';
    } catch {
      return 'unavailable';
    }
  }

  protected context(handshake: ISocketHandshake): AuthnContext {
    const userAgent = handshake.headers['user-agent'];
    return { ip: handshake.address, userAgent: typeof userAgent === 'string' ? userAgent : undefined, now: new Date(), purpose: 'request' };
  }

  protected async extract(request: SignedRequest): Promise<Credentials | null> {
    const extractors = [...((await DI.resolve(Array.ofType(CredentialExtractor))) as CredentialExtractor[])].sort((a, b) => a.order - b.order);

    for (const extractor of extractors) {
      const credentials = extractor.extract(request);
      if (credentials) {
        return credentials;
      }
    }

    return null;
  }
}
