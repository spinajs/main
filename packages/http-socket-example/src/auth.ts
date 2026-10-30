import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { IdentityStore, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, IdentityStatus } from '@spinajs/authn/contracts';
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

const DEMO_USERS = new Map([...DEMO_TOKENS.values()].map(({ id, user }) => [id, user]));

/**
 * Demo only: the two fixed users. @spinajs/authn resolves its login service through these contracts; a real app
 * installs @spinajs/users (identity store and principal factory) instead.
 */
@Injectable(IdentityStore)
export class DemoIdentityStore extends IdentityStore {
  public async findByLogin(login: string): Promise<IdentityRef | null> {
    const found = [...DEMO_TOKENS.values()].find(({ user }) => user.name === login);
    return found ? { type: 'user', id: found.id } : null;
  }

  public async status(id: IdentityRef): Promise<IdentityStatus> {
    return { exists: DEMO_USERS.has(id.id), active: true, banned: false, deleted: false };
  }

  public async display(id: IdentityRef): Promise<{ name?: string }> {
    return { name: DEMO_USERS.get(id.id)?.name };
  }
}

@Injectable(PrincipalFactory)
export class DemoPrincipalFactory extends PrincipalFactory {
  public async principalOf(id: IdentityRef, _facts: AuthnFacts, extra: { attributes?: Readonly<Record<string, unknown>> }): Promise<Principal> {
    return Object.freeze({ type: 'user', id: id.id, authenticated: true, source: 'demo', attributes: Object.freeze({ ...extra.attributes }), identity: DEMO_USERS.get(id.id) });
  }
}
