# Replay protection

Every JWS assertion `jti` and every HTTP signature `nonce` is accepted once. `KeyNonceStore` remembers each claimed value until the credential it came from can no longer be valid. `DbKeyNonceStore` keeps the claims in `authn_nonce`, shared by every app instance; `MemoryKeyNonceStore` keeps them in one process.

Login and register challenges are single use too, through `SecretStore`, not through this store. See [Challenge login](04-challenge-login.md).

## How it works

### Which values are claimed

| Strategy | Value | Store key | Kept until |
| --- | --- | --- | --- |
| `JwsAssertionStrategy` | the `jti` claim | `nonceKey('jti', kid, jti)` | `exp + authn.keys.assertion.skewSeconds` |
| `HttpSignatureStrategy` | the `nonce` parameter | `nonceKey('sig', kid, nonce)` | `expires + authn.keys.httpSignature.skewSeconds` |

- `nonceKey(scope, kid, value)` is `<scope>:` plus the base64url SHA-256 of `<kid>\n<value>`: 47 characters, whatever the client sent. The value is scoped to the key that signed it, so two keys never collide.
- Each strategy claims only after the signature and every other check pass. A forged credential cannot use up a real client's value.
- A claim that returns `false` fails the request with `invalid_credentials`.

### `DbKeyNonceStore.claim(key, expiresAt, now)`

1. On every 64th claim of the instance, it first deletes up to 500 rows with `expires_at <= now`.
2. It inserts `AuthnNonce { k: key, expires_at: expiresAt }`. Success returns `true`: the primary key makes this the first claim.
3. When the insert fails, it updates `expires_at` where `k = key` and `expires_at <= now`. One changed row returns `true`: the earlier claim had expired and this call took it over.
4. Otherwise a row with that key still exists and the call returns `false`. When no row exists (a purge removed it in between), the insert error is rethrown.

### `MemoryKeyNonceStore.claim(key, expiresAt, now)`

1. On every 256th claim, it deletes every expired entry of its map.
2. A live entry (`expiresAt > now`) returns `false`. Otherwise it stores `expiresAt` for `key` and returns `true`.

## Configuration

The store reads no key. The expiry comes from the credential:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.keys.assertion.skewSeconds` | `integer` | `30` | `0`-`300` | Added to an assertion's `exp` |
| `authn.keys.httpSignature.skewSeconds` | `integer` | `30` | `0`-`300` | Added to a signature's `expires` |

`assertion.maxLifetimeSeconds` and `httpSignature.maxAgeSeconds` (both at most 300) cap how long a credential, and so its claim, can live.

## Schema

### `authn_nonce`

Created by `@spinajs/authn-orm`'s `AuthnInitial` migration on the `default` connection. This package ships only the `AuthnNonce` model for it.

| Column | Type | Meaning |
| --- | --- | --- |
| `k` | `varchar(160)`, primary key | The store key, `jti:<hash>` or `sig:<hash>` |
| `expires_at` | `datetime`, not null | The claim holds until this instant; after it the key may be claimed again |

`@spinajs/authn-orm`'s `NonceStore` writes the same table. See [Nonce store](../authn-orm/04-nonce-store.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Key nonce store | `KeyNonceStore`, singleton; also registered as `DbKeyNonceStore` | `DbKeyNonceStore` | `MemoryKeyNonceStore` (exported, not registered) | `DI.register(MemoryKeyNonceStore).as(KeyNonceStore)` for one process, or a subclass of `KeyNonceStore` with `@Injectable(KeyNonceStore)`. Register after `@spinajs/authn-keys` is imported |

A custom store implements one method, `claim(key, expiresAt, now)`. It returns `true` exactly once while `key` is live, keeps a claimed key until `expiresAt`, and lets an expired key be claimed again. Claims must be atomic across every app instance.

### Key nonce store: custom implementation

`@spinajs/authn-orm`'s `DbNonceStore` has the same semantics, checks its arguments, waits for the ORM, and retries a claim that a purge raced. Delegate to it to keep one nonce store for the whole app:

```ts sample
import { Inject, Injectable } from '@spinajs/di';
import { NonceStore } from '@spinajs/authn-orm';
import { KeyNonceStore } from '@spinajs/authn-keys';

/** Assertion jtis and signature nonces go through the app's one NonceStore. */
@Injectable(KeyNonceStore)
@Inject(NonceStore)
export class SharedKeyNonceStore extends KeyNonceStore {
  constructor(protected readonly nonces: NonceStore) {
    super();
  }

  public claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    return this.nonces.claim(key, expiresAt, now);
  }
}
```

Import this file after `@spinajs/authn-keys` and `@spinajs/authn-orm`.

## Important behaviour

- `DbKeyNonceStore` claims are atomic across processes: of many parallel claims of one key, exactly one returns `true`.
- A claim can be taken again once it expires. By then the credential is past its own expiry plus the skew, so the strategy refuses it before it reaches the store.
- `DbKeyNonceStore` rethrows the insert error when a purge removes the row between its steps, so the request fails instead of passing. `DbNonceStore` of `@spinajs/authn-orm` retries in that case.
- `MemoryKeyNonceStore` is per process. Behind a load balancer, a replay sent to another instance passes. Use it only for tests and single-process apps.
- Without the `authn_nonce` table every `keys-jws` and `keys-httpsig` request fails at the claim. Run `@spinajs/authn-orm`'s migrations.

## Best practices

- Keep `skewSeconds` small. It extends how long each row lives, and so the size of `authn_nonce`.
- Import `@spinajs/authn-orm` in every app that lists `keys-jws` or `keys-httpsig`: it creates the table and supplies the `SecretStore` and throttle the package also needs.

## Patterns and antipatterns

```ts
// Don't: the memory store in an app with several instances; each instance accepts the same jti once
DI.register(MemoryKeyNonceStore).as(KeyNonceStore);

// Do: keep the default DbKeyNonceStore, or delegate to authn-orm's NonceStore as above
```

## Examples

### Check replay protection in a test

```ts sample
import { MemoryKeyNonceStore, nonceKey } from '@spinajs/authn-keys';

/** Shows that a replayed signature nonce is refused until the claim expires. */
export async function replayIsRefused(): Promise<boolean> {
  const store = new MemoryKeyNonceStore();
  const now = new Date('2026-10-20T12:00:00Z');
  const until = new Date(now.getTime() + 90_000);
  const key = nonceKey('sig', 'runner-1-key', 'a8f3c2d1e0b94f67');
  const first = await store.claim(key, until, now);
  const replay = await store.claim(key, until, new Date(now.getTime() + 10_000));
  return first && !replay;
}
```

## Related

- [JWS client assertions](05-jws-assertions.md): where `jti` is claimed.
- [HTTP message signatures](06-http-signatures.md): where `nonce` is claimed.
- [`@spinajs/authn-orm` nonce store](../authn-orm/04-nonce-store.md): `NonceStore`, `DbNonceStore` and the `authn_nonce` migration.
