import { Injectable } from '@spinajs/di';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

const TOKEN_PREFIX = 'spt_test-';

/** The `authn.strategies` entry a suite adds to let {@link bearerTokenOf} authenticate as a per-request token principal. */
export const TOKEN_STRATEGY = { name: 'token', service: 'TokenTestStrategy' };

/** A bearer token of user `uuid` that {@link TokenTestStrategy} accepts; sent as `Authorization: Bearer <token>`. */
export const bearerTokenOf = (uuid: string): string => `${TOKEN_PREFIX}${uuid}`;

/**
 * Stands in for authn-token: a {@link bearerTokenOf} value authenticates its user per request, with no session and no
 * ceiling. Registered on import; it runs only where `authn.strategies` lists it.
 */
@Injectable(AuthenticationStrategy)
export class TokenTestStrategy extends AuthenticationStrategy {
  public readonly name = 'token';
  public readonly kinds = ['bearer'];
  public readonly interactive = false;

  public throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    if (c.kind !== 'bearer') return [];
    const account = `token:${String(c.token).slice(TOKEN_PREFIX.length)}`;
    return [
      { kind: 'account', value: account },
      { kind: 'account-ip', value: `${account}|${ctx.ip ?? ''}` },
    ];
  }

  public async verify(c: Credentials): Promise<StrategyOutcome> {
    if (c.kind !== 'bearer') return { ok: false, reason: 'unsupported_credentials' };
    const token = String(c.token);
    return token.startsWith(TOKEN_PREFIX) ? { ok: true, identity: { type: 'user', id: token.slice(TOKEN_PREFIX.length) }, method: 'token' } : { ok: false, reason: 'invalid_credentials' };
  }
}
