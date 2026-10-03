import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { SocketPrincipalSource } from '@spinajs/http-socket';
import type { ISocketHandshake } from '@spinajs/http-socket';

export interface DemoUser {
  name: string;
}

const DEMO_TOKENS = new Map<string, { id: string; user: DemoUser }>([
  ['alice-token', { id: '1', user: { name: 'alice' } }],
  ['bob-token', { id: '2', user: { name: 'bob' } }],
]);

/**
 * Demo only: two fixed tokens. A real app uses AuthnCredentialSource ( bearer tokens, keys and
 * signatures through @spinajs/authn, built in ) or the session-cookie source of @spinajs/authn-http/socket.
 */
@Injectable(SocketPrincipalSource)
export class DemoTokenSource extends SocketPrincipalSource {
  public readonly name = 'demo';
  public readonly order = 10;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    const known = typeof token === 'string' ? DEMO_TOKENS.get(token) : undefined;

    if (!known) {
      return null;
    }

    return Object.freeze({ type: 'user', id: known.id, authenticated: true, source: 'demo', attributes: Object.freeze({}), identity: known.user });
  }
}
