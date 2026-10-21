# Setup and configuration

Importing `@spinajs/authn-keys` registers the key registry, the stores, the JWS verifier and three strategies. You turn authentication by key on by listing the strategies in `authn.strategies` and setting an audience under `authn.keys`.

## How it works

1. Importing the package runs the `@Injectable` decorators. Each one registers a class in the root DI container, under its contract and under itself:
   - `DefaultKeyRegistry` as `KeyRegistry`,
   - `OrmKeyStore` as `KeyStore`,
   - `DbKeyNonceStore` as `KeyNonceStore`,
   - `StrictJwsVerifier` as `JwsVerifier`,
   - `JwsAssertionStrategy`, `HttpSignatureStrategy` and `KeyChallengeStrategy` as `AuthenticationStrategy`.
2. The `@Model` and `@Migration` decorators register the `AuthnKey` and `AuthnNonce` models and the `AuthnKeys_2026_10_02_00_00_00` migration on the `default` connection.
3. The package's config file adds its `lib/<cjs|mjs>/cli` folder to `system.dirs.cli`, so the `spinajs` bin finds `authn:key-add`, `authn:key-list` and `authn:key-revoke`. It adds nothing else: the `authn.keys` defaults come from the `@spinajs/authn` schema.
4. At boot, the authn core's `StrategyRegistry` reads `authn.strategies` and picks each listed strategy by class name. A registered strategy that is not listed never runs. See [Strategies](../authn/03-strategies.md).
5. `JwsAssertionStrategy.resolve()` throws when `authn.keys.assertion.audience` is `null`. `KeyChallengeStrategy.resolve()` throws when both `authn.keys.challenge.audience` and `authn.keys.assertion.audience` are `null`. `HttpSignatureStrategy` needs no audience.
6. Every class reads `authn.keys` through `@Config('authn.keys')` and passes it to `keysOptionsOf()`. That function checks the numeric ranges, freezes the result, and fills `challenge.audience` from `assertion.audience` when it is `null`. A value outside a range throws `InvalidOption('authn.keys.<block>.<key> must be an integer from <min> to <max>')`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.keys.algorithms` | `string[]` | `['EdDSA', 'ES256']` | non-empty, unique; `EdDSA`, `ES256` | Key types `register` accepts, and header `alg` values a JWS assertion may carry |
| `authn.keys.challenge.ttlSeconds` | `integer` | `120` | `1`-`3600` | Lifetime of a register or login challenge |
| `authn.keys.challenge.audience` | `string \| null` | `null` | non-empty string or `null` | The service name clients put in a challenge's signing input; `null` falls back to `assertion.audience` |
| `authn.keys.assertion.typ` | `string` | `'spinajs-client+jwt'` | non-empty string | The JWS header `typ` of a client assertion; `authn-http` also uses it to tell an assertion from a JWT |
| `authn.keys.assertion.audience` | `string \| null` | `null` | non-empty string or `null` | The `aud` claim an assertion must carry; required when `keys-jws` is listed |
| `authn.keys.assertion.maxLifetimeSeconds` | `integer` | `300` | `1`-`300` | Largest `exp - iat` of an assertion |
| `authn.keys.assertion.skewSeconds` | `integer` | `30` | `0`-`300` | Clock skew allowed on `iat` and `exp` |
| `authn.keys.httpSignature.maxAgeSeconds` | `integer` | `300` | `1`-`300` | Largest `expires - created` of a signature |
| `authn.keys.httpSignature.skewSeconds` | `integer` | `30` | `0`-`300` | How far `created` may lie in the future |
| `authn.keys.httpSignature.requiredComponents` | `string[]` | `['@method', '@target-uri', 'content-digest']` | component names | Components every signature must cover; `content-digest` only applies to a request with a body |
| `authn.keys.cache.ttlSeconds` | `integer` | `10` | `>= 0` | Seconds `KeyRegistry.byId` serves a key from memory; `0` turns the cache off. See [Key cache](02-key-registry.md#key-cache) |
| `authn.keys.cache.maxEntries` | `integer` | `10000` | `>= 1` | Cached keys held at most |
| `authn.strategies` | `{ name, service }[]` | `[]` | see below | The strategies that run; owned by `@spinajs/authn` |

The strategy entries this package provides:

| `name` | `service` | Credential kind | Starts a session |
| --- | --- | --- | --- |
| `keys-jws` | `JwsAssertionStrategy` | `jws-assertion` | no |
| `keys-httpsig` | `HttpSignatureStrategy` | `http-signature` | no |
| `keys-challenge` | `KeyChallengeStrategy` | `key-challenge` | yes |

```ts
authn: {
  strategies: [
    { name: 'local', service: 'LocalPasswordStrategy' },
    { name: 'keys-jws', service: 'JwsAssertionStrategy' },
    { name: 'keys-httpsig', service: 'HttpSignatureStrategy' },
    { name: 'keys-challenge', service: 'KeyChallengeStrategy' },
  ],
  keys: {
    assertion: { audience: 'https://api.example.com' },
    // challenge.audience falls back to assertion.audience
  },
  http: {
    // authn-http builds the signed @target-uri from this origin; without it no request yields http-signature credentials
    publicOrigin: 'https://api.example.com',
  },
}
```

Config files concatenate arrays, so the package lists no strategy: list each one once, in one app config file. See [Config `authn.*`](../authn/13-configuration-and-boot-checks.md).

## Schema

The tables are on the `default` connection:

- `authn_key`: created by this package's migration `AuthnKeys_2026_10_02_00_00_00`. Columns in [Key store](03-key-store.md#schema).
- `authn_nonce`: created by `@spinajs/authn-orm`'s `AuthnInitial` migration. This package ships only a model for it. Columns in [Replay protection](07-replay-protection.md#schema).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Key registry | `KeyRegistry` (`@spinajs/authn/contracts`), singleton | `DefaultKeyRegistry` | none | Subclass `DefaultKeyRegistry`, see [Key registry](02-key-registry.md#services-and-extension-points) |
| Key store | `KeyStore`, singleton | `OrmKeyStore` | `MemoryKeyStore` (exported, not registered) | See [Key store](03-key-store.md#services-and-extension-points) |
| Nonce store | `KeyNonceStore`, singleton | `DbKeyNonceStore` | `MemoryKeyNonceStore` (exported, not registered) | See [Replay protection](07-replay-protection.md#services-and-extension-points) |
| JWS verifier | `JwsVerifier` (`@spinajs/authn/contracts`), singleton | `StrictJwsVerifier` | none | See [JWS and key material](08-jws-and-key-material.md#services-and-extension-points) |
| Strategies | `AuthenticationStrategy`, picked by class name from `authn.strategies` | `JwsAssertionStrategy`, `HttpSignatureStrategy`, `KeyChallengeStrategy` | your own | See [Custom key strategies](09-custom-key-strategies.md) |

The registry and the strategies also resolve services this package does not register:

| Needed by | Contract | Shipped by |
| --- | --- | --- |
| `DefaultKeyRegistry`, `KeyChallengeStrategy` | `SecretStore` | `DbSecretStore` in [`@spinajs/authn-orm`](../authn-orm/02-secret-store.md) |
| `DefaultKeyRegistry` (login challenge throttle) | `AuthnThrottle` | `MemoryAuthnThrottle` in `@spinajs/authn`, `DbAuthnThrottle` in [`@spinajs/authn-orm`](../authn-orm/01-throttle.md) |
| `DefaultKeyRegistry` (`key.register`, `key.revoke` events) | `AuthnAudit`, which delivers to every `AuthnEventSink` | `@spinajs/authn`, see [Audit and events](../authn/06-audit-events.md) |

`DefaultKeyRegistry` injects `AuthnThrottle` with a plain `@Autoinject`, so it takes the last registration of `AuthnThrottle`, not the one `authn.throttle.service` names.

## Important behaviour

- The schema fills the whole `authn.keys` block with defaults, even when the app sets none of it.
- Every module that reads `authn.keys` imports `@spinajs/authn/register-schema`, so the schema applies even in a CLI process that never loads the `@spinajs/authn` root. There a violation does not fail the import; the first read throws `InvalidConfiguration` naming the path, for example `authn.keys.challenge.ttlSeconds`.
- `keysOptionsOf()` caches per config object. A reloaded configuration gives fresh options.
- `authn.keys.algorithms` is read by `register` and by the JWS assertion check only. Dropping `ES256` stops new P-256 keys and P-256 assertions, but HTTP signatures and challenge logins of P-256 keys registered before still verify. Revoke those keys.
- A `requiredComponents` entry the signature base cannot hold (an unknown `@` name, `signature`, `signature-input`) makes every signed request fail. See [HTTP message signatures](06-http-signatures.md#how-it-works).
- `authn-http` turns its key routes off (404) while no `KeyRegistry` is registered or neither audience is set. Importing this package registers one.

## Best practices

- Set `authn.keys.assertion.audience` to the public URL clients call, and use the same value on the client side. Never derive it from a request.
- Set `challenge.audience` only when challenges must name a different service identity than assertions.
- Keep `assertion.maxLifetimeSeconds` low (60 is enough for a client that signs per request). A shorter lifetime shortens how long each `jti` is stored.
- List only the strategies you use. An unlisted strategy runs no code.

## Patterns and antipatterns

```ts
// Don't: keys-jws without an audience; JwsAssertionStrategy.resolve() throws at boot
authn: {
  strategies: [{ name: 'keys-jws', service: 'JwsAssertionStrategy' }],
}

// Do
authn: {
  strategies: [{ name: 'keys-jws', service: 'JwsAssertionStrategy' }],
  keys: { assertion: { audience: 'https://api.example.com' } },
}
```

## Examples

### Read the effective options in a health check

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { keysOptionsOf } from '@spinajs/authn-keys';
import type { KeysConfig } from '@spinajs/authn-keys';

/** Reports which audience clients must sign for, as the strategies read it. */
export async function keyAudiences(): Promise<{ assertion: string | null; challenge: string | null }> {
  const config = await DI.resolve(Configuration);
  const options = keysOptionsOf(config.get<KeysConfig>('authn.keys'));
  return { assertion: options.assertion.audience, challenge: options.challenge.audience };
}
```

## Related

- [Authentication in SpinaJS 3.0](../authn/README.md): how a login runs, strategy dispatch, throttling.
- [`@spinajs/authn-http`](../authn-http/README.md): `authn.http.publicOrigin`, the extractors and the key routes.
- [`@spinajs/authn-orm`](../authn-orm/README.md): `SecretStore`, `AuthnThrottle` and `authn_nonce`.
- [Command discovery](../cli/05-command-discovery.md): how `system.dirs.cli` finds the key commands.
