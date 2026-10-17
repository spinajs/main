# 2.x sessions and the boot sweep

Sessions written by `@spinajs/session-provider-redis` 2.x stay valid after the upgrade. `sweepLegacy()` adds them to the 3.0 index sets, so a ban, a password reset or a "sign out everywhere" reaches them before their owner's next request migrates them.

## How it works

### What a 2.x row looks like

- Key `session:<uuid v4>`: the raw session id, not its hash.
- Value: `{ UserId, Creation, Expiration, Data }`, with no `Subject`, `Impersonator` or `State`.
- Identity in `Data`: `User` (the `users.Uuid`), `Authorized` (`true` after 2FA) and `Impersonator`.
- Index: only `session:user:<UserId>`, which 3.0 never reads.

### Reading a 2.x row

1. `toSession()` finds no `Subject` and passes the row to `adaptLegacySession()` from `@spinajs/authn-session`.
2. `Subject` becomes `{ type: 'user', id: Data.User }`, `Impersonator` comes from `Data.Impersonator`, and `State` is `'active'` only when `Data.Authorized === true`, else `'pending'`.
3. A row without `Data.User` reads as `null`: it is absent for `restore`, lookups and the sweep.
4. `touch()` renews a 2.x row in place and keeps its 2.x shape: `UserId` stays and no `Subject` is added. `DefaultSessionIssuer` re-saves the row under its hashed key on the owner's first request; this store does not migrate rows itself.

### The sweep, `sweepLegacy()`

1. `RedisSessionStore.resolve()` calls it once per boot.
2. `scanSessionKeys()` runs `SCAN` with `MATCH <keyPrefix>session:*`, 500 keys per batch, and strips the prefix from each key.
3. Keys whose id contains `:` (the index sets) are skipped. The rest are read with one `MGET` per batch.
4. A value whose `Subject` is a string is a 3.0 row and is skipped. Every other value goes through the lenient `toSession()`: an unparseable value, or a 2.x row without `User`, is skipped.
5. One `MULTI` per batch runs `SADD` to `session:subject:<principalKey>` and, when the row has an impersonator, `session:impersonator:<principalKey>`.
6. The store logs `Indexed <count> 2.x sessions by subject and impersonator` at `info` level and returns the count.

## Configuration

The sweep has no keys of its own. It scans under `authn.session.redis.keyPrefix`; see [Redis session store](01-redis-session-store.md#configuration).

## Schema

| Key | Written by | Read by 3.0 |
| --- | --- | --- |
| `session:<uuid>` | 2.x | Yes, through `adaptLegacySession()` |
| `session:user:<UserId>` | 2.x | No; left in place, deleted by `truncate()` |
| `session:subject:<principalKey>` | The sweep, for each 2.x row | Yes, by `listBySubject()` and `deleteBySubject()` |
| `session:impersonator:<principalKey>` | The sweep, for each impersonated 2.x row | Yes, with `includeImpersonations: true` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Legacy sweep | `RedisSessionStore.sweepLegacy()`, public, on the singleton store | Runs in `resolve()` | Call it yourself, any time | Override `sweepLegacy()` in a [subclass](03-extending-the-redis-store.md#session-store-subclass-redissessionstore); the override also replaces the boot run |
| 2.x adapter | `adaptLegacySession()` function from `@spinajs/authn-session` | Shared by every store | none | Not replaceable from this package; override `toSession()` in a subclass to read a different row shape |

## Important behaviour

- **Idempotent.** `SADD` adds a member once, so running the sweep again changes nothing for rows it already indexed. 3.0 rows and 2.x rows without `User` are never touched.
- **The sweep does not rewrite rows.** It adds set members only; the 2.x value, key and TTL stay.
- **Expired 2.x rows are indexed too.** Lookups delete them later and do not count them.
- **Rolling-upgrade window.** A 2.x node that writes a session after a 3.0 node booted leaves a row no set lists. `deleteBySubject()` returns `0` for it until `sweepLegacy()` runs again.
- **One bad value does not stop the sweep.** Unparseable values are skipped with a `warn` log.
- **Boot cost.** The sweep reads every `session:*` key under the prefix on every boot, 3.0 rows included, even when no 2.x row is left.

## Best practices

- Run `sweepLegacy()` once more after the last 2.x node is gone, or on a schedule during a rolling upgrade, so late 2.x sessions join the index.
- Point `authn.session.redis` (`db`, `keyPrefix`) at the keys the 2.x store wrote. Elsewhere, the sweep and `restore` do not see the old rows, and every 2.x user must sign in again.

## Patterns and antipatterns

```ts
// Don't: deleting the 2.x index sets by hand signs nobody out; the rows stay valid until they expire.
await redis.del('session:user:1');

// Do: end the sessions through the 3.0 index, after the sweep has indexed them.
await store.sweepLegacy();
await store.deleteBySubject({ type: 'user', id: userUuid });
```

## Examples

### Index late 2.x sessions after a rolling upgrade

```ts sample
import { DI } from '@spinajs/di';
import { RedisSessionStore } from '@spinajs/session-provider-redis';

/** Run once the last 2.x node is drained, from a deploy hook or a CLI command. */
export async function finishSessionUpgrade(): Promise<void> {
  const store = await DI.resolve(RedisSessionStore);
  const indexed = await store.sweepLegacy();
  console.log(`${indexed} 2.x sessions indexed`);
}
```

### Repeat the sweep while 2.x nodes are still serving

```ts sample
import { DI } from '@spinajs/di';
import { RedisSessionStore } from '@spinajs/session-provider-redis';

/** Every 5 minutes during the upgrade; call the returned function when the last 2.x node is gone. */
export async function sweepDuringUpgrade(): Promise<() => void> {
  const store = await DI.resolve(RedisSessionStore);
  const timer = setInterval(() => {
    store.sweepLegacy().catch((err: unknown) => console.error('2.x session sweep failed', err));
  }, 5 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
```

## Related

- [Redis session store](01-redis-session-store.md): the 3.0 key layout and revocation the sweep feeds.
- [`@spinajs/authn` sessions](../authn/README.md#sessions): how the issuer migrates a 2.x session to its hashed key on first use.
