import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ISession, SessionExpirationProvider } from './interfaces.js';

/**
 * Absolute expiration: the session dies at a fixed instant from creation and is
 * never extended. `touch` is therefore a no-op (renew returns the current
 * Expiration unchanged).
 *
 * Settings: `rbac.session.expiration.ttl` (minutes).
 */
@Injectable(SessionExpirationProvider)
export class AbsoluteExpiration extends SessionExpirationProvider {
  @Config('rbac.session.expiration.ttl', { defaultValue: 120 })
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
 * Settings: `rbac.session.expiration.ttl` (minutes).
 */
@Injectable(SessionExpirationProvider)
export class SlidingExpiration extends SessionExpirationProvider {
  @Config('rbac.session.expiration.ttl', { defaultValue: 120 })
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
 * Settings: `rbac.session.expiration.ttl` and
 * `rbac.session.expiration.maxLifetime` (both minutes).
 */
@Injectable(SessionExpirationProvider)
export class SlidingCappedExpiration extends SessionExpirationProvider {
  @Config('rbac.session.expiration.ttl', { defaultValue: 120 })
  protected Ttl!: number;

  @Config('rbac.session.expiration.maxLifetime', { defaultValue: 1440 })
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
