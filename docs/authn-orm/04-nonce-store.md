# Nonce store

A nonce store answers "is this the first use of this value?" for single-use values that expire: a JWS `jti`, an HTTP signature nonce, an OIDC `state`. `NonceStore` is the contract (`@spinajs/authn/contracts`), `DbNonceStore` keeps the claims in `authn_nonce` for every app instance, and `MemoryNonceStore` (`@spinajs/authn/nonces`) keeps them in one process. This package re-exports both.

## Where it runs in the authn flow

| Caller | Key | When it calls |
| --- | --- | --- |
| `OidcProvider.complete()` ([`@spinajs/authn-oidc`](../authn-oidc/README.md)) | `oidc-state:<hex SHA-256 of the state>` | Login step 3 of [How a login runs](../authn/01-authentication-flow.md): `OidcStrategy.verify()` completes the callback, which claims the `state` once before any network call. A second use refuses the callback. The claim expires with the OIDC flow. |

`OidcProviders` injects `NonceStore` with `@Autoinject(NonceStore)`, so an app with `@spinajs/authn-oidc` needs this package or its own `NonceStore` registration.

[`@spinajs/authn-keys`](../authn-keys/README.md) does not call this store. Its own `DbKeyNonceStore` (token `KeyNonceStore`) claims assertion `jti`s and HTTP signature nonces in the same `authn_nonce` table, through its own `AuthnNonce` model. Its keys are `jti:` or `sig:` followed by the base64url SHA-256 of the key id and the value, so they never collide with OIDC states.

## How it works

### Claim, `DbNonceStore.claim(key, expiresAt, now)`

1. The store checks `key` (a non-empty string of at most 160 characters) and that `expiresAt` and `now` are valid `Date`s between the years 1000 and 9999. A bad value throws `InvalidArgument`.
2. It awaits `ormReady()`. On every 64th claim of the instance it runs `purge(now)` first.
3. `AuthnNonce.insert({ k: key, expires_at: expiresAt })`. Success resolves `true`: the primary key makes this the first claim.
4. On a duplicate key, `AuthnNonce.update({ expires_at: expiresAt })` runs where `k` matches and `expires_at <= now`. One changed row resolves `true`: the earlier claim had expired and this call took it over.
5. Otherwise the store reads whether a row with that key is still live (`expires_at > now`). A live row resolves `false`.
6. No row at all means a purge removed it between the steps; the store goes back to step 3, up to 8 times, then resolves `false`.

### Purge, `DbNonceStore.purge(now?)`

1. `purge(now = new Date())` selects up to 500 keys with `expires_at <= now`, ordered by key.
2. It deletes those keys under the same condition and resolves with the number deleted.

### `MemoryNonceStore.claim(key, expiresAt, now)`

1. The same argument checks as `DbNonceStore`.
2. On every 64th claim it deletes every expired entry of its map.
3. A live entry for `key` resolves `false`; otherwise it stores `expiresAt` for `key` and resolves `true`.

## Configuration

The nonce store reads no key. Callers pick `expiresAt`, usually the end of the time the credential stays acceptable. `@spinajs/authn-oidc` passes the end of the OIDC flow, 600 seconds after the flow started.

## Schema

### `authn_nonce`

| Column | Type | Meaning |
| --- | --- | --- |
| `k` | `varchar(160)`, primary key | The claimed value, as given. |
| `expires_at` | `datetime` | The claim holds until this time; after it the key may be claimed again. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Nonce store | `NonceStore` (`@spinajs/authn/contracts`), per child container; also registered as `DbNonceStore` | `DbNonceStore` | `MemoryNonceStore` (exported, not registered) | `DI.register(MemoryNonceStore).as(NonceStore)` for one process, or subclass `DbNonceStore` with `@Injectable(NonceStore)`. Register after this package is imported: a single resolve takes the last registration. |

`@spinajs/authn-keys` has its own `KeyNonceStore` contract with the same semantics; see [Where it runs in the authn flow](#where-it-runs-in-the-authn-flow).

### Nonce store: custom implementation

Subclass `DbNonceStore`, override `claim`, call `super`, and register the subclass under `NonceStore`.

```ts sample
import { DbNonceStore, NonceStore } from '@spinajs/authn-orm';
import { Injectable, PerChildInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

/** Logs every replayed value, so a security alert can fire on a burst of replays. */
@PerChildInstance()
@Injectable(NonceStore)
export class ReplayLoggingNonceStore extends DbNonceStore {
  @Logger('security')
  protected Log: Log;

  public override async claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    const first = await super.claim(key, expiresAt, now);
    if (!first) {
      this.Log.warn('a single-use value was presented again while still live');
    }
    return first;
  }
}
```

## Important behaviour

- `claim` resolves `true` exactly once while a key is live, across every app instance on the database. The primary key decides; no transaction is used.
- An `expiresAt` at or before `now` is never live, so such a claim on a free key always resolves `true`. Refuse expired credentials before you claim their nonce.
- After its `expiresAt` passes, a key may be claimed again. Pick `expiresAt` at least as late as the credential stays acceptable.
- Time comes from the caller's `now`; SQL `now()` is never used.
- Keys are stored as given. On MySQL and MSSQL the default collations ignore case, so keys that differ only in case collide there.
- Expired rows stay until a purge. The purge runs on every 64th claim of the instance and deletes at most 500 rows.
- `MemoryNonceStore` serves one process only: each instance and each restart starts empty.

## Best practices

- Prefix keys by their kind (`jti:`, `oidc-state:`), so values of two credential types never collide in one table.
- Use `MemoryNonceStore` in unit tests that run without a database, never in an app with several instances.

## Patterns and antipatterns

```ts
// Don't: an expired assertion's jti always claims, so the replay check passes
const first = await nonces.claim(`jti:${jti}`, new Date(exp * 1000), now);

// Do: refuse the expired credential first, then claim
if (exp * 1000 <= now.getTime()) return false;
const first = await nonces.claim(`jti:${jti}`, new Date(exp * 1000), now);
```

## Examples

### Accept each webhook delivery once

```ts sample
import { NonceStore } from '@spinajs/authn-orm';
import { DI } from '@spinajs/di';

const ACCEPT_FOR_MS = 5 * 60 * 1000;

/** True for the first delivery of an id within five minutes of sending; false for a replay or a late delivery. */
export async function firstDelivery(deliveryId: string, sentAt: Date): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(sentAt.getTime() + ACCEPT_FOR_MS);
  if (expiresAt <= now) return false;

  const nonces = await DI.resolve(NonceStore);
  return await nonces.claim(`webhook:${deliveryId}`, expiresAt, now);
}
```

### Run OIDC callback tests without a database

```ts sample
import { MemoryNonceStore, NonceStore } from '@spinajs/authn-orm';
import { DI } from '@spinajs/di';

export function useInMemoryNonces(): void {
  DI.register(MemoryNonceStore).as(NonceStore);
}
```

## Related

- [`@spinajs/authn-oidc`](../authn-oidc/README.md): the OIDC `state` claimed once on callback.
- [`@spinajs/authn-keys`](../authn-keys/README.md): `DbKeyNonceStore`, which shares the `authn_nonce` table.
- [Models and schema](07-models-and-schema.md#authn_nonce): the `AuthnNonce` model.
