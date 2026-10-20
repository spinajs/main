import { DI, Injectable } from '@spinajs/di';
import { AuthenticationStrategy, IdentityStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

/** The password every seeded account has for {@link ReauthTestStrategy}. */
export const ACCOUNT_PASSWORD = 'Reauth-passw0rd';

/** The `authn.strategies` entry a suite sets to let fresh auth verify `reauthPassword` through AuthnService.reauthenticate. */
export const REAUTH_STRATEGIES = [{ name: 'local', service: 'ReauthTestStrategy' }];

/**
 * A password strategy over users' IdentityStore that accepts {@link ACCOUNT_PASSWORD} for every account, so authn's real
 * re-authentication (throttle, identity and status checks, audit) runs behind authn-http's fresh auth. Registered on
 * import; it runs only where `authn.strategies` lists it.
 */
@Injectable(AuthenticationStrategy)
export class ReauthTestStrategy extends AuthenticationStrategy {
  public readonly name = 'local';
  public readonly kinds = ['password'];
  public readonly interactive = true;

  public throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    if (c.kind !== 'password') return [];
    const account = String(c.login).toLowerCase();
    return [
      { kind: 'account', value: account },
      { kind: 'account-ip', value: `${account}|${ctx.ip ?? ''}` },
    ];
  }

  public async verify(c: Credentials): Promise<StrategyOutcome> {
    if (c.kind !== 'password') return { ok: false, reason: 'unsupported_credentials' };
    const identity = await ((await DI.resolve(IdentityStore)) as IdentityStore).findByLogin(String(c.login));
    return identity && c.password === ACCOUNT_PASSWORD ? { ok: true, identity, method: 'password' } : { ok: false, reason: 'invalid_credentials' };
  }
}
