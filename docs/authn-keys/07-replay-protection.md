# Replay protection

Every JWS assertion `jti` and every HTTP signature `nonce` is accepted once. The core `NonceStore` (`@spinajs/authn/contracts`) remembers each claimed value until the credential it came from can no longer be valid. `@spinajs/authn-orm` registers `DbNonceStore`, which keeps the claims in `authn_nonce`, shared by every app instance; `MemoryNonceStore` (`@spinajs/authn/nonces`) keeps them in one process. This package has no nonce store of its own.

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

### Booting without a `NonceStore`

`JwsAssertionStrategy.resolve()` and `HttpSignatureStrategy.resolve()` check that a `NonceStore` is registered. When none is, they throw `InvalidOption('<strategy name> needs a NonceStore: import @spinajs/authn-orm (DbNonceStore) or register your own NonceStore')` and the app does not start. Nothing registers a store for you: importing `@spinajs/authn-keys` alone is not enough.

### `NonceStore.claim(key, expiresAt, now)`

The strategies call `claim` and take `false` as a replay. `DbNonceStore` and `MemoryNonceStore` implement it the same way: the first claim of a live key returns `true`, a claim of a key that is still live returns `false`, and a key whose `expiresAt` has passed may be claimed again. Keys over 160 characters throw; `nonceKey` keys are 47. How `DbNonceStore` does this atomically is in [Nonce store](../authn-orm/04-nonce-store.md).

## Configuration

The store reads no key. The expiry comes from the credential:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.keys.assertion.skewSeconds` | `integer` | `30` | `0`-`300` | Added to an assertion's `exp` |
| `authn.keys.httpSignature.skewSeconds` | `integer` | `30` | `0`-`300` | Added to a signature's `expires` |

`assertion.maxLifetimeSeconds` and `httpSignature.maxAgeSeconds` (both at most 300) cap how long a credential, and so its claim, can live.

## Schema

### `authn_nonce`

Created by `@spinajs/authn-orm`'s `AuthnInitial` migration on the `default` connection. The `AuthnNonce` model that reads and writes it is in `@spinajs/authn-orm` too.

| Column | Type | Meaning |
| --- | --- | --- |
| `k` | `varchar(160)`, primary key | The store key, `jti:<hash>` or `sig:<hash>` |
| `expires_at` | `datetime`, not null | The claim holds until this instant; after it the key may be claimed again |

See [Nonce store](../authn-orm/04-nonce-store.md) for `DbNonceStore`, which writes it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Nonce store | `NonceStore` (`@spinajs/authn/contracts`), per child container | `DbNonceStore`, registered by `@spinajs/authn-orm`; none without it | `MemoryNonceStore` (`@spinajs/authn/nonces`, not registered) | `DI.register(MemoryNonceStore).as(NonceStore)` for one process, or a subclass of `NonceStore` or `DbNonceStore` with `@Injectable(NonceStore)`. A single resolve takes the last registration, so register after `@spinajs/authn-orm` is imported |

A custom store implements one method, `claim(key, expiresAt, now)`. It returns `true` exactly once while `key` is live, keeps a claimed key until `expiresAt`, and lets an expired key be claimed again. Claims must be atomic across every app instance. `runNonceStoreConformance` from `@spinajs/authn-testing` checks all of that. The same store serves the OIDC `state` claims of `@spinajs/authn-oidc`, so replacing it replaces both.

## Important behaviour

- The strategies refuse to boot without a registered `NonceStore`; the error names `@spinajs/authn-orm`. Apps that moved from an earlier build must import it or register their own store.
- `DbNonceStore` claims are atomic across processes: of many parallel claims of one key, exactly one returns `true`.
- A claim can be taken again once it expires. By then the credential is past its own expiry plus the skew, so the strategy refuses it before it reaches the store.
- `MemoryNonceStore` is per process. Behind a load balancer, a replay sent to another instance passes. Use it only for tests and single-process apps.
- Without the `authn_nonce` table every `keys-jws` and `keys-httpsig` request fails at the claim. Run `@spinajs/authn-orm`'s migrations.

## Best practices

- Keep `skewSeconds` small. It extends how long each row lives, and so the size of `authn_nonce`.
- Import `@spinajs/authn-orm` in every app that lists `keys-jws` or `keys-httpsig`: it supplies the `NonceStore`, creates the table, and provides the `SecretStore` and throttle the package also needs.

## Patterns and antipatterns

```ts
// Don't: the memory store in an app with several instances; each instance accepts the same jti once
DI.register(MemoryNonceStore).as(NonceStore);

// Do: import @spinajs/authn-orm and keep its DbNonceStore
```

## Examples

### Check replay protection in a test

```ts sample
import { MemoryNonceStore } from '@spinajs/authn/nonces';
import { nonceKey } from '@spinajs/authn-keys';

/** Shows that a replayed signature nonce is refused until the claim expires. */
export async function replayIsRefused(): Promise<boolean> {
  const store = new MemoryNonceStore();
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
- [`@spinajs/authn-orm` nonce store](../authn-orm/04-nonce-store.md): `DbNonceStore` and the `authn_nonce` migration.
