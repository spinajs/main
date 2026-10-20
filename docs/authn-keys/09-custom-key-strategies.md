# Custom key strategies

Extend a shipped strategy to add a rule, or write a new strategy that verifies registered keys. The package exports `KeyStrategy`, the base of its three strategies, and the helpers they use, so a custom one gets the same key lookup, equal-time failures, throttle keys and last-use stamps.

## How it works

A key strategy follows the steps the shipped ones do:

1. Refuse another credential kind with `failure('unsupported_credentials')`, so the core passes the credential on.
2. Refuse oversized input before parsing: `MAX_CREDENTIAL_LENGTH` is 8,192.
3. Do every check that needs no key first.
4. `usableKey(registry, kid, ctx)` returns `{ key }` for a key that is neither revoked nor expired at `ctx.now` (`isUsableKey`), or `{ key: null, reason, alg? }` with `reason` `invalid_credentials`, `revoked` or `expired`.
5. With no usable key, run `unknownKeyWork(alg, data, signature)` (on `KeyStrategy`; `dummyVerify` outside it) and return `failure(reason)`. The failure then costs what a real verification costs (A02), and `reason` reaches audit only.
6. `verifySignature(key, data, signature)` checks the signature with the key's own algorithm.
7. Claim any single-use value in `KeyNonceStore` after the signature holds.
8. The protected `success(key, method, ctx)` of `KeyStrategy` calls `KeyRegistry.touch(kid, ctx.now)` when the registry implements it and returns `{ ok: true, identity: owner, method, ceiling: key.scope }`. A `touch` that throws is logged and the login still succeeds.

`throttleKeys(credentials, ctx)` returns `keyThrottleKeys(kid, ctx)`: an `account` key `key:<kid>` and an `account-ip` key `key:<kid>|<ip>`. A kid that is not valid becomes `key:?`. Read the kid from the unverified credential: throttling runs before verification. The core drops the strategy's `account-ip` key and builds its own from each `account` key and `ctx.ip`.

`KeyStrategy<D extends KeyStrategyDeps>` extends `AuthenticationStrategy`. It reads `authn.keys` through `@Config`, `@Autoinject`s `KeyRegistry` and a logger, and takes an optional `deps` object in its constructor, a seam for building a strategy with `new` in tests: `KeyStrategyDeps` has `registry` and `options` (complete `KeysOptions`, which bypass `authn.keys`). The shipped strategies extend it with their own deps: `JwsAssertionStrategyDeps` (`verifier`, `nonces`), `HttpSignatureStrategyDeps` (`nonces`), `KeyChallengeStrategyDeps` (`secrets`). Each field replaces what DI injects.

| Helper | Signature | Purpose |
| --- | --- | --- |
| `usableKey` | `(registry, kid, ctx) => Promise<KeyLookup>` | Key lookup that refuses revoked and expired keys and reports why |
| `isUsableKey` | `(key, now) => boolean` | Not revoked and before `expiresAt` |
| `failure` | `(reason) => StrategyOutcome` | `{ ok: false, reason }` |
| `keyThrottleKeys` | `(kid \| null, ctx) => ThrottleKey[]` | Throttle keys from a kid |
| `assertionIssuer` | `(owner) => string` | `<type>:<id>`, the `iss` of an assertion |
| `loginChallengeIdentity` | `(kid) => IdentityRef` | The `SecretStore` identity of a login challenge |
| `MAX_CREDENTIAL_LENGTH` | `8192` | Input cap before parsing |

The protected members of the shipped strategies:

| Member | On | Override to |
| --- | --- | --- |
| `registry` | `KeyStrategy` | Take the `KeyRegistry` from elsewhere; the default is `deps.registry`, else the injected one |
| `success(key, method, ctx)` | `KeyStrategy` | Change the success outcome or the last-use stamp |
| `unknownKeyWork(alg, data, signature)` | `KeyStrategy` | Change the equal-time work for an unusable key; keep its cost equal to a real verification |
| `check(req, ctx)` | `HttpSignatureStrategy` | Add rules that need no key; return `null` to refuse |
| `audience` | `JwsAssertionStrategy`, `KeyChallengeStrategy` | Read the audience from elsewhere; `resolve()` reads it at boot |
| `options` | `KeyStrategy` | Read `KeysOptions` from elsewhere |

## Configuration

A subclass of a shipped strategy keeps its `name`. List it under that name with your class as `service`, instead of the shipped class:

```ts
authn: {
  strategies: [{ name: 'keys-httpsig', service: 'PaymentsSignatureStrategy' }],
}
```

A new strategy gets its own `name` and credential kind, and its own entry in `authn.strategies`. `authn-http` needs a `CredentialExtractor` that builds the new kind from a request; see [`@spinajs/authn-http`](../authn-http/README.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Key strategies | `AuthenticationStrategy`, picked by class name from `authn.strategies` | `JwsAssertionStrategy`, `HttpSignatureStrategy`, `KeyChallengeStrategy` | your subclass or your own strategy | `@Injectable(AuthenticationStrategy)` on your class, then list it in `authn.strategies` |

### Strategies: custom implementation

Tighten the signature window for payment routes by extending `HttpSignatureStrategy.check()`:

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, SignedRequest } from '@spinajs/authn/contracts';
import { HttpSignatureStrategy } from '@spinajs/authn-keys';

const PAYMENT_MAX_AGE_SECONDS = 10;

/** A signature on /payments must be created within the last 10 seconds. */
@Injectable(AuthenticationStrategy)
export class PaymentsSignatureStrategy extends HttpSignatureStrategy {
  protected check(req: SignedRequest, ctx: AuthnContext) {
    const checked = super.check(req, ctx);
    if (!checked || !new URL(req.targetUri).pathname.startsWith('/payments')) {
      return checked;
    }
    const created = checked.input.params.get('created') as number;
    return Math.floor(ctx.now.getTime() / 1000) - created <= PAYMENT_MAX_AGE_SECONDS ? checked : null;
  }
}
```

## Important behaviour

- The collaborators are `@Autoinject` properties, so a subclass needs no constructor and no `@Inject`.
- `success()` stamps `lastUsedAt` only through a registry that implements the optional `touch`. `DefaultKeyRegistry` does; a `KeyRegistry` written from scratch without it gets no stamps.
- A strategy registered with `@Injectable(AuthenticationStrategy)` runs only when `authn.strategies` lists it. The shipped class stays registered next to your subclass and does nothing unless listed.
- A non-interactive strategy is counted only after a failure when the throttle supports `peek` (K5), so it must take only unguessable credentials: signatures or secrets of 128 bits or more.
- Strategies verify only. Sessions, MFA, identity status and events belong to the authn core. See [How a login runs](../authn/01-authentication-flow.md).

## Best practices

- Return `unsupported_credentials` only for another kind. For your own kind, every refusal is `invalid_credentials`, `revoked` or `expired`.
- Call `unknownKeyWork` (or `dummyVerify`) on every path that finds no usable key, with the key's algorithm when the lookup reports one.
- Bind a signed value to a time window and claim it in `KeyNonceStore`, as the shipped strategies do. A signature alone can be replayed.

## Patterns and antipatterns

```ts
// Don't: return early for an unknown key; the fast answer tells an attacker which kids exist
const found = await usableKey(this.registry, kid, ctx);
if (!found.key) return failure(found.reason);

// Do: spend the same signature work first
if (!found.key) {
  this.unknownKeyWork(found.alg ?? 'EdDSA', data, signature);
  return failure(found.reason);
}
```

## Examples

### Accept webhooks a partner signs with its registered key

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { KeyNonceStore, KeyStrategy, MAX_CREDENTIAL_LENGTH, decodeB64url, failure, keyThrottleKeys, nonceKey, usableKey, verifySignature } from '@spinajs/authn-keys';

const WINDOW_SECONDS = 300;

interface WebhookCredentials {
  kid?: unknown;
  timestamp?: unknown;
  signature?: unknown;
  body?: unknown;
}

/** Credentials { kind: 'partner-webhook', kid, timestamp, signature, body }: the partner signs `<timestamp>.<body>`. */
@Injectable(AuthenticationStrategy)
export class PartnerWebhookStrategy extends KeyStrategy {
  public readonly name = 'partner-webhook';
  public readonly kinds = ['partner-webhook'];
  public readonly interactive = false;

  @Autoinject(KeyNonceStore)
  protected Nonces: KeyNonceStore;

  public throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    const { kid } = c as WebhookCredentials;
    return keyThrottleKeys(c.kind === 'partner-webhook' && typeof kid === 'string' ? kid : null, ctx);
  }

  public async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    if (c.kind !== 'partner-webhook') {
      return failure('unsupported_credentials');
    }
    const { kid, timestamp, signature, body } = c as WebhookCredentials;
    if (typeof kid !== 'string' || typeof signature !== 'string' || signature.length > MAX_CREDENTIAL_LENGTH || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || !(body instanceof Uint8Array)) {
      return failure('invalid_credentials');
    }
    if (Math.abs(Math.floor(ctx.now.getTime() / 1000) - timestamp) > WINDOW_SECONDS) {
      return failure('invalid_credentials');
    }

    const data = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
    const raw = decodeB64url(signature) ?? Buffer.alloc(0);
    const found = await usableKey(this.registry, kid, ctx);
    if (!found.key) {
      this.unknownKeyWork(found.alg ?? 'EdDSA', data, raw);
      return failure(found.reason);
    }
    if (!verifySignature(found.key, data, raw)) {
      return failure('invalid_credentials');
    }
    if (!(await this.Nonces.claim(nonceKey('sig', found.key.kid, signature), new Date((timestamp + WINDOW_SECONDS) * 1000), ctx.now))) {
      return failure('invalid_credentials');
    }
    return this.success(found.key, 'partner-webhook', ctx);
  }
}
```

Register the partner's key with `authn:key-add service <partner>`, and list `{ name: 'partner-webhook', service: 'PartnerWebhookStrategy' }` in `authn.strategies`.

## Related

- [JWS and key material](08-jws-and-key-material.md): `verifySignature`, `dummyVerify` and the key checks.
- [Replay protection](07-replay-protection.md): `KeyNonceStore` and `nonceKey`.
- [Strategies](../authn/03-strategies.md): the strategy contract and how the registry picks strategies.
