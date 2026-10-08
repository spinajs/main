import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { ISession, LegacySessionExpirationProvider } from './interfaces.js';
import { registerRenamedService } from './legacy-services.js';

registerRenamedService(LegacySessionExpirationProvider, 'AbsoluteExpiration', () => LegacyAbsoluteExpiration);
registerRenamedService(LegacySessionExpirationProvider, 'SlidingExpiration', () => LegacySlidingExpiration);
registerRenamedService(LegacySessionExpirationProvider, 'SlidingCappedExpiration', () => LegacySlidingCappedExpiration);

/**
 * Absolute expiration: the session dies at a fixed instant from creation and is
 * never extended. `touch` is therefore a no-op (renew returns the current
 * Expiration unchanged).
 *
 * Settings: `authn.session.expiration.ttl` (minutes).
 *
 * @deprecated 3.0: the same class of @spinajs/authn-session. R1 deletes it with the 2.x session store.
 */
@Injectable(LegacySessionExpirationProvider)
export class LegacyAbsoluteExpiration extends LegacySessionExpirationProvider {
  @Config('authn.session.expiration.ttl')
  protected Ttl!: number;

  public initial(session: ISession): DateTime | undefined {
    return session.Creation.plus({ minutes: this.Ttl });
  }

  public renew(session: ISession): DateTime | undefined {
    // no slide — keep whatever absolute instant was set at creation
    return session.Expiration;
  }
}

/**
 * Sliding expiration: every renewal pushes the expiration to `now + ttl`, with
 * no upper bound. Activity keeps the session alive indefinitely.
 *
 * Settings: `authn.session.expiration.ttl` (minutes).
 *
 * @deprecated 3.0: the same class of @spinajs/authn-session. R1 deletes it with the 2.x session store.
 */
@Injectable(LegacySessionExpirationProvider)
export class LegacySlidingExpiration extends LegacySessionExpirationProvider {
  @Config('authn.session.expiration.ttl')
  protected Ttl!: number;

  public initial(_session: ISession): DateTime | undefined {
    return DateTime.now().plus({ minutes: this.Ttl });
  }

  public renew(_session: ISession): DateTime | undefined {
    return DateTime.now().plus({ minutes: this.Ttl });
  }
}

/**
 * Sliding expiration with an absolute cap: renewal pushes the expiration to
 * `now + ttl` but never past `Creation + maxLifetime`. Combines idle timeout
 * with a hard session lifetime ceiling.
 *
 * Settings: `authn.session.expiration.ttl` and
 * `authn.session.expiration.maxLifetime` (both minutes).
 *
 * @deprecated 3.0: the same class of @spinajs/authn-session. R1 deletes it with the 2.x session store.
 */
@Injectable(LegacySessionExpirationProvider)
export class LegacySlidingCappedExpiration extends LegacySessionExpirationProvider {
  @Config('authn.session.expiration.ttl')
  protected Ttl!: number;

  @Config('authn.session.expiration.maxLifetime')
  protected MaxLifetime!: number;

  public initial(_session: ISession): DateTime | undefined {
    return DateTime.now().plus({ minutes: this.Ttl });
  }

  public renew(session: ISession): DateTime | undefined {
    const slide = DateTime.now().plus({ minutes: this.Ttl });
    const cap = session.Creation.plus({ minutes: this.MaxLifetime });
    return slide < cap ? slide : cap;
  }
}

/** @deprecated 3.0: LegacyAbsoluteExpiration, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export const AbsoluteExpiration = LegacyAbsoluteExpiration;
/** @deprecated 3.0: LegacyAbsoluteExpiration, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export type AbsoluteExpiration = LegacyAbsoluteExpiration;

/** @deprecated 3.0: LegacySlidingExpiration, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export const SlidingExpiration = LegacySlidingExpiration;
/** @deprecated 3.0: LegacySlidingExpiration, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export type SlidingExpiration = LegacySlidingExpiration;

/** @deprecated 3.0: LegacySlidingCappedExpiration, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export const SlidingCappedExpiration = LegacySlidingCappedExpiration;
/** @deprecated 3.0: LegacySlidingCappedExpiration, renamed so DI never mixes it with authn-session's. R1 deletes it. */
export type SlidingCappedExpiration = LegacySlidingCappedExpiration;
