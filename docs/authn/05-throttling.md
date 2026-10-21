# Throttling

`AuthnThrottle` slows down guessing. It never locks an account: after a few free attempts, each key waits longer before the next one, up to a cap. `MemoryAuthnThrottle` serves one process; `DbAuthnThrottle` from [`@spinajs/authn-orm`](../authn-orm/README.md) serves several instances.

The generic mechanics (`Throttle`, `ThrottleStore`, `KeyedBackoff`) are in [`@spinajs/util`](../util/10-throttle.md). This page covers the authn parts: key kinds, flows, configuration and DI.

## How it works

1. `DefaultAuthnService` builds the keys of an attempt (below) and picks the flow: `login`, `mfa` or `reauth`. `@spinajs/authn-local` uses `reset` for password resets.
2. `attempt(keys, flow, ctx)` checks every gating key and counts the attempt in one step. It resolves `{ allowed: true }`, or `{ allowed: false, retryAfterSeconds }` with the longest delay among the gating keys. A refused attempt is counted nowhere.
3. `peek(keys, flow, ctx)` answers the same way and counts nothing. With a throttle that has it, per-request strategies count only their failures: the service peeks before verify and calls `attempt` after a failure. An allowed peek also says `clean`: `{ allowed: true, clean: true }` means no live row holds the keys, so a success has nothing to lower or clear and the service skips `succeed`. A token or key with no failures on record then writes nothing to the throttle.
4. `succeed(keys, flow)` applies the success rule (below).

### Backoff

After counted attempt `n` on a key, the next attempt waits `0` while `n < free`, and `min(baseDelayMs × 2^(n − free), maxDelayMs)` once `n ≥ free` (`backoffDelayMs`). So `free` attempts run with no wait, and the wait after attempt number `free` is `baseDelayMs`. A key with no counted attempt for `resetAfterSeconds` starts from zero. The server never sleeps: the caller gets `Retry-After`.

### Keys

| Kind | Gates | Params used |
| --- | --- | --- |
| `account` | When the flow has `account` params | The flow's `account` |
| `ip` | When the flow has `ip` params | The flow's `ip` |
| `global` | When `authn.throttle.global` is set | `global`, counted per flow |
| `account-ip` | Never; counted when the flow has `ip` | None |
| Other kinds | Ignored | None |

Rows are keyed by an HMAC of `flow\|kind\|value`, so no table holds a login or an address. `MemoryAuthnThrottle` uses a random key per instance; `DbAuthnThrottle` uses `authn.audit.hashKey.secret`.

### Keys the service builds

For `login`, from each candidate strategy's `throttleKeys`:

- An `account` key of an interactive strategy becomes `login:<value>`. A per-request strategy's becomes `request:<value>|<ip>`, so failures sent from another address never delay the credential's owner.
- For each account key, when `ctx.ip` is set, the service adds `account-ip` = `<account key>|<ip>`. A strategy's own `account-ip` keys are dropped.
- The shared keys: `ip` (when `ctx.ip` is set) and `global` with value `login` (when `authn.throttle.global` is set).
- In all three keys that carry the address (`ip`, `account-ip` and a per-request `account`), an IPv6 address is replaced by its network, `<network>/<prefix>`, with the prefix from `authn.throttle.ipv6Prefix`: a client that owns a whole /64 cannot get a fresh row for each address. IPv4 and IPv4-mapped addresses are keyed whole. Audit events and `ClientIp` keep the full address. The `mfa`, `reauth` and reset keys still use the plain address.
- The attempt counts the union of every candidate's keys, once. `succeed` gets only the answering strategy's keys and the shared ones.

For `mfa` and `reauth`: `account` = the identity id, `account-ip` = `<identity id>|<ip>`, and `ip` when `ctx.ip` is set.

### Success rule

| Flow | On success |
| --- | --- |
| `login`, `mfa`, `reauth` | Deletes the `account` and `account-ip` rows. Lowers the `ip` row by the attempts this account spent from this IP, never by more |
| `reset` | Clears nothing; only time does |

A login to your own account cannot clear failures spent on other accounts.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.throttle.service` | `string` | unset | A registered `AuthnThrottle` class name | The throttle to use; see [Choosing the throttle](#choosing-the-throttle) |
| `authn.throttle.login.account` | `BackoffParams` | `{ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }` | `free` ≥ 0, `baseDelayMs` ≥ 0, `maxDelayMs` ≥ 1 | Per login name |
| `authn.throttle.login.ip` | `BackoffParams` | `{ free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }` | as above | Per client IP |
| `authn.throttle.mfa.account` | `BackoffParams` | `{ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }` | as above | Per identity, second factor |
| `authn.throttle.mfa.ip` | `BackoffParams` | `{ free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }` | as above | Per IP, second factor |
| `authn.throttle.reset.account` | `BackoffParams` | `{ free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }` | as above | Per account, reset requests |
| `authn.throttle.reset.ip` | `BackoffParams` | `{ free: 5, baseDelayMs: 10000, maxDelayMs: 900000 }` | as above | Per IP, reset requests |
| `authn.throttle.reauth.account` | `BackoffParams` | `{ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }` | as above | Per identity, re-authentication. No `ip` params |
| `authn.throttle.resetAfterSeconds` | `integer` | `86400` | ≥ 1 | A key with no counted attempt for this long starts from zero |
| `authn.throttle.global` | `BackoffParams \| null` | `null` | as above | One key for all logins. Off by default: one attacker could slow every login |
| `authn.throttle.maxRows` | `integer` | `1000000` | 4 to 16000000 | Rows a `MemoryAuthnThrottle` keeps per flow; memory grows with 4 × `maxRows` |
| `authn.throttle.ipv6Prefix` | `integer` | `64` | 16 to 128 | Prefix length that IPv6 clients are grouped by in the login throttle keys |
| `authn.throttle.memory.sweepBatch` | `integer` | `8` | 1 to 1000 | Expired rows `MemoryAuthnThrottle` checks per attempt |
| `authn.throttle.memory.fullRetrySeconds` | `integer` | `60` | 1 to 3600 | `Retry-After` of a full table with no delay to wait for |
| `authn.throttle.memory.holdOffMs` | `integer` | `1000` | 0 to 60000 | Pause before the next scan of a nearly full table |

```ts
authn: {
  throttle: {
    service: 'DbAuthnThrottle',
    login: { account: { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
    resetAfterSeconds: 86400,
    global: null,
  },
}
```

An unknown key under `authn.throttle` or `authn.throttle.memory` fails the boot. `MemoryAuthnThrottle` reads the configuration once, at first use.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnThrottle` | `AuthnThrottle`, named by `authn.throttle.service` or picked | `MemoryAuthnThrottle` (root singleton) | `DbAuthnThrottle` ([`@spinajs/authn-orm`](../authn-orm/README.md)) | Extend `StoreAuthnThrottle`, register with `@Injectable(AuthnThrottle)` and name it |
| `FlowLimiter` | Class token, new instance per flow | `FlowLimiter` | Your subclass | Register a subclass as `FlowLimiter` to replace the table of every flow of `MemoryAuthnThrottle` |
| `PeekableThrottle` | Interface | `StoreAuthnThrottle.peek` | | Implement `peek` on your own `AuthnThrottle`; answer `clean: false` when unsure, since a `clean: true` skips `succeed` |

### Choosing the throttle

`DefaultAuthnService` injects the throttle with `@AutoinjectNamedService('authn.throttle.service', AuthnThrottle, AUTHN_THROTTLE_SERVICE)`:

1. `authn.throttle.service` set: that registered class. A name that is not registered fails the boot.
2. Unset: `pickAuthnThrottle` takes the only registered throttle, or the only one besides `MemoryAuthnThrottle`. Importing `@spinajs/authn-orm` is enough to get `DbAuthnThrottle`.
3. Unset with two or more throttles besides the memory one: boot fails. Name one.

Boot never falls back to memory: in an app with several instances each would count apart. After the choice, `DefaultAuthnService` calls the throttle's optional `checkConfiguration(configuration)`; a throw fails the boot. A throttle without `peek` makes per-request strategies count before verify, and boot logs a warning.

|  | `MemoryAuthnThrottle` | `DbAuthnThrottle` |
| --- | --- | --- |
| Scope | One process; each instance counts apart | All instances, over the database |
| Restart | Forgets every row | Keeps rows |
| Capacity | `maxRows` per flow, with eviction | The table |
| Key hash | Random per-instance secret | `authn.audit.hashKey.secret` |

### StoreAuthnThrottle: custom implementation

Write a throttle over a store the shipped ones do not cover, such as Redis. `StoreAuthnThrottle` (also at `@spinajs/authn/store-throttle`, which registers nothing) supplies the flow rules; you supply:

- `params`: the `ThrottleParams`, read once. The store must apply `params.resetAfterSeconds` as its expiry.
- `store()`: the util `ThrottleStore`, built lazily, once. A failed build is retried on the next call.
- `keyId(flow, key)`: an opaque id that includes the flow and never holds the plain key value.

You may override `rules(params)`, `checkKeys`, `nowMs` and `throttleName`.

```ts sample
import { createHmac } from 'node:crypto';
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthnThrottle, StoreAuthnThrottle } from '@spinajs/authn';
import type { ThrottleConfig, ThrottleFlow, ThrottleKey, ThrottleParams } from '@spinajs/authn';
import type { ThrottleStore } from '@spinajs/util';

export abstract class RedisThrottleStores {
  abstract open(expireAfterMs: number): Promise<ThrottleStore>;
}

@Singleton()
@Injectable(AuthnThrottle)
export class RedisAuthnThrottle extends StoreAuthnThrottle {
  @Config('authn.throttle')
  protected Throttle: ThrottleConfig;

  @Config('authn.audit.hashKey.secret')
  protected HashKey: string;

  @Autoinject(RedisThrottleStores)
  protected Stores: RedisThrottleStores;

  protected get params(): ThrottleParams {
    const { service: _service, maxRows: _maxRows, memory: _memory, ...params } = this.Throttle;
    return params;
  }

  protected store(): Promise<ThrottleStore> {
    return this.Stores.open(this.params.resetAfterSeconds * 1000);
  }

  protected keyId(flow: ThrottleFlow, key: ThrottleKey): string {
    return createHmac('sha256', this.HashKey).update(`${flow}|${key.kind}|${key.value}`).digest('base64url');
  }
}
```

```ts
authn: {
  throttle: { service: 'RedisAuthnThrottle' },
  audit: { hashKey: { secret: '<32+ characters, from a secret reference>' } },
}
```

Register a throttle as a class, not a factory: a factory is called once per container, and each container would count apart.

## Important behaviour

- Never a lock: the owner of an account waits at most `maxDelayMs` (60 s for `login.account`), however many failures others cause.
- An interactive attempt is counted before it is verified, with one atomic claim per key. Of N parallel attempts on a fresh key, exactly `free` are verified.
- Peek and count are two steps. A parallel burst of per-request failures is verified in full before the backoff applies. That is safe only for unguessable credentials.
- A refused attempt answers the same for known and unknown logins.
- `MemoryAuthnThrottle` evicts rows that delay nobody when a flow's table is full, oldest first. A row that is delaying is never evicted. When none can go, attempts that need a new row are refused, and a warning naming the flow goes to the `authn-throttle` log.
- `ctx.now` must be a valid `Date`, or `attempt` and `peek` throw `InvalidArgument`. An unknown flow throws too.

## Best practices

- Use `DbAuthnThrottle` behind a load balancer or with several instances. Keep `MemoryAuthnThrottle` for development, tests and a single instance.
- Set `http.trustProxy` or `authn.http.trustProxy` behind a proxy. Without it every client has the proxy's address and shares one `ip` key.
- Leave `authn.throttle.global` off unless you accept that one attacker can slow every login.

## Patterns and antipatterns

```ts
// Don't: a FlowLimiter subclass with @Autoinject and no @NewInstance becomes a singleton; one table serves every flow
@Injectable(FlowLimiter)
class MeteredLimiter extends FlowLimiter {
  @Autoinject(Metrics) protected Metrics: Metrics;
}

// Do: declare @NewInstance() again on a subclass with any DI decorator
@NewInstance()
@Injectable(FlowLimiter)
class MeteredLimiter extends FlowLimiter {
  @Autoinject(Metrics) protected Metrics: Metrics;
}
```

`MemoryAuthnThrottle` checks what DI returns for each flow and fails with `InvalidOperation` on a shared instance, an instance of another flow, or anything but a `FlowLimiter`.

## Related

- [Authentication flow](01-authentication-flow.md): when `attempt`, `peek` and `succeed` run.
- [`@spinajs/authn-orm`](../authn-orm/README.md): `DbAuthnThrottle` and its table.
- [`@spinajs/util` throttle](../util/10-throttle.md) and [custom throttle stores](../util/11-custom-throttle-stores.md): the store contract.
