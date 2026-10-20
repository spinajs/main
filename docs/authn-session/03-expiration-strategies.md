# Expiration strategies

An expiration strategy decides when a session dies: a fixed time after login (absolute timeout), a time after the last request (idle timeout), or both. Every store asks the same strategy, so a session expires at the same instant whichever store holds it. The shipped default, `SlidingCappedExpiration`, ends a session after 30 idle minutes or 8 hours after login, whichever comes first.

## How it works

The strategy is a `SessionExpirationProvider` with two methods. `SessionProvider` calls them; the issuer never does.

1. `SessionProvider.save()` of a row with no `Expiration` calls `applyInitialExpiration()`, which sets `Expiration = strategy.initial(row)`. A row that already has an `Expiration` is stored as is.
2. `SessionProvider.touch()` calls `applyRenewedExpiration()`, which sets `Expiration = strategy.renew(row)` for an active row. A pending row keeps its expiration.
3. `SessionProvider.restore()` answers `null` for a row whose `Expiration` is at or before now. A row with no `Expiration` never expires.

When each step runs:

| Issuer call | Store call | Expiration |
| --- | --- | --- |
| `issue` (active) | `save` | `initial()` |
| `issue` (pending) | `save` | now + `authn.session.pendingTtlSeconds`, set by the issuer |
| `restore` of an active session (not peeking) | `touch` | `renew()` |
| `set` | `touch` | `renew()` for an active session, unchanged for a pending one |
| `rotate` | `save` | copied from the old row |
| `elevate` | `save` | `initial()` of the now active row, with the original `Creation` |
| 2.x migration | `save` | the 2.x expiration, capped for a pending row; see [2.x session migration](10-2x-session-migration.md) |

### Shipped strategies

| Strategy | `initial()` | `renew()` | Use it for |
| --- | --- | --- | --- |
| `AbsoluteExpiration` | `Creation + ttl` | the current `Expiration`, unchanged | A hard lifetime with no idle timeout, for example kiosks or shared terminals |
| `SlidingExpiration` | now + `ttl` | now + `ttl` | An idle timeout only; an active user stays signed in indefinitely |
| `SlidingCappedExpiration` | the same as `renew()` | the earlier of now + `ttl` and `Creation + maxLifetime` | Idle timeout plus a hard lifetime (the default) |

All values are minutes.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.session.expiration.service` | string | `'SlidingCappedExpiration'` (shipped config; the schema has no default) | `AbsoluteExpiration`, `SlidingExpiration`, `SlidingCappedExpiration`, or the class name of your own registered `SessionExpirationProvider` | The strategy every store uses |
| `authn.session.expiration.ttl` | integer | `30` | 1 or more | Minutes: the idle timeout of the sliding strategies, the whole lifetime of `AbsoluteExpiration` |
| `authn.session.expiration.maxLifetime` | integer | `480` | 1 or more | Minutes from `Creation`: the cap of `SlidingCappedExpiration`. Other strategies ignore it |
| `authn.session.pendingTtlSeconds` | integer | `300` | 1 or more | Seconds: lifetime of a pending (pre-MFA) session, never extended |

```ts
authn: {
  session: {
    // An admin back office: 15 idle minutes, never longer than a working day.
    expiration: { service: 'SlidingCappedExpiration', ttl: 15, maxLifetime: 600 },
  },
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Expiration strategy | `SessionExpirationProvider`; each strategy registers with `@Injectable(SessionExpirationProvider)` on import, singleton. Every `SessionProvider` injects one with `@AutoinjectService('authn.session.expiration', SessionExpirationProvider)` into its protected `Expiration` | `SlidingCappedExpiration` | `AbsoluteExpiration`, `SlidingExpiration` | Register your subclass with `@Injectable(SessionExpirationProvider)` and name its class in `authn.session.expiration.service` |

`@AutoinjectService` passes the whole `authn.session.expiration` object to the strategy's constructor, so a strategy of your own can carry extra keys there. See [Config-selected services](../configuration/08-config-selected-services.md).

### `SessionExpirationProvider`: custom implementation

Write a strategy when the timeout depends on something other than a fixed number of minutes: a time of day, a tenant setting, the assurance level. Implement both methods; return `undefined` for a session that never expires. Import the module before the first store resolves.

```ts sample
import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { SessionExpirationProvider } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';

/**
 * Store terminals: 20 idle minutes, and every session ends at closing time.
 * Select it with authn.session.expiration: { service: 'ClosingTimeExpiration', ttl: 20 }.
 */
@Injectable(SessionExpirationProvider)
export class ClosingTimeExpiration extends SessionExpirationProvider {
  @Config('authn.session.expiration.ttl')
  protected Ttl!: number;

  @Config('terminals.closingHour', { defaultValue: 21 })
  protected ClosingHour!: number;

  public initial(session: ISession): DateTime | undefined {
    return this.renew(session);
  }

  public renew(session: ISession): DateTime | undefined {
    const idle = DateTime.now().plus({ minutes: this.Ttl });
    const closing = session.Creation.set({ hour: this.ClosingHour, minute: 0, second: 0, millisecond: 0 });
    const cap = closing > session.Creation ? closing : closing.plus({ days: 1 });
    return idle < cap ? idle : cap;
  }
}
```

Keep settings of your own under a config path your app owns, as `terminals.closingHour` above: the `authn` schema describes only `service`, `ttl` and `maxLifetime` under `authn.session.expiration`.

## Important behaviour

- **Server-side only.** The cookie `@spinajs/authn-http` sends is a browser-session cookie with no `Max-Age`. The store enforces both timeouts; a browser that keeps the cookie gets `null` from `restore` once the row expired.
- **`initial()` keeps an old `Creation` in check.** `SlidingCappedExpiration.initial()` is capped like `renew()`, because `elevate` and the 2.x migration give a row with an old `Creation` a fresh initial expiration.
- **`AbsoluteExpiration.renew()` changes nothing**, so `touch` reports no change. The issuer still calls it on every request.
- **Missing values expire at once.** A `ttl` or `maxLifetime` that is missing at runtime (set past the schema) makes `initial()` return `Creation` or earlier: the session is born expired instead of living forever. The same holds for a missing `pendingTtlSeconds`.
- **A pending row needs its own expiration.** `applyInitialExpiration()` throws `Error('A pending session must carry its own expiration (authn.session.pendingTtlSeconds)')` for a pending row without one.
- **Process clock.** The strategies and `SessionProvider.isExpired()` use `DateTime.now()` of the Node process, not the clock of a database.
- **Rotation keeps the deadline.** `rotate` copies `Expiration`, so a role switch never extends a session.

## Best practices

- Keep `SlidingCappedExpiration` for user-facing apps: `ttl` bounds an unattended screen, `maxLifetime` bounds a stolen cookie.
- Remember that `maxLifetime` also bounds impersonations: an impersonation ends once the original login is `maxLifetime` old ([Impersonation and the active role](../authn/11-impersonation-and-active-role.md)).
- Read config in a custom strategy with `@Config`, as the shipped ones do; do not cache a computed deadline in the strategy, which is a singleton shared by every store.

## Patterns and antipatterns

```ts
// Don't: SlidingExpiration alone lets a stolen cookie live as long as someone keeps using it
expiration: { service: 'SlidingExpiration', ttl: 30 },

// Do: cap the lifetime as well
expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 },
```

## Examples

### A kiosk that signs out after exactly 10 minutes

```ts
authn: {
  session: {
    expiration: { service: 'AbsoluteExpiration', ttl: 10 },
  },
},
```

Activity never extends the session: `renew()` keeps the instant set at login.

## Related

- [Session stores](04-session-stores.md): where `applyInitialExpiration`, `applyRenewedExpiration` and `isExpired` run.
- [Issuing and restoring sessions](01-issuing-and-restoring-sessions.md): which issuer calls save and touch.
- [Config-selected services](../configuration/08-config-selected-services.md): how the strategy is picked by name.
- [Injecting config values](../configuration/07-injecting-config-values.md): `@Config` in a custom strategy.
