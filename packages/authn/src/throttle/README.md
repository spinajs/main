# Throttle

Backoff for failed authentication, behind the `AuthnThrottle` contract. It never locks an account (H31): a key
only waits longer. The mechanics (`Throttle`, `ThrottleStore`, `KeyedBackoff`, writing a store) are in
`@spinajs/util`: `packages/util/documentation/resilience.md`. This package supplies the authn parts: key kinds,
the flow rules, configuration and DI.

- `MemoryAuthnThrottle` (this package) serves one process, on `MemoryThrottleStore`.
- `DbAuthnThrottle` (`@spinajs/authn-orm`) serves several, on `DbThrottleStore`.
- `StoreAuthnThrottle` is the base of both and the way to add a store.

## Contract

- `attempt(keys, flow, ctx)` checks every gating key and counts the attempt in one step. It resolves
  `{ allowed: true }`, or `{ allowed: false, retryAfterSeconds }` when a delay holds: the longest one among the
  gating keys. A refused attempt is counted nowhere (A05, A06). `ctx.now` must be a valid `Date`.
- `peek(keys, flow, ctx)` (`PeekableThrottle`) answers the same way and counts nothing. A full table does not
  refuse it. With a peekable throttle, when every candidate strategy is per-request, `DefaultAuthnService` peeks
  before verify and counts only failures, with `attempt` (K5).
- `succeed(keys, flow)` is the success rule, below.

Flows are `login`, `mfa`, `reset` and `reauth`. They never share rows. Any other flow is an `InvalidArgument`, and
so is a key whose `value` is not a string. The util `Throttle` checks only the keys an operation uses, so a key of
a kind the flow ignores may carry anything; `DbAuthnThrottle` checks every key of `attempt` and `succeed`
(`checkKeys`), also in `reset`.

## Keys

| Kind         | Gates                                 | Params used                |
| ------------ | ------------------------------------- | -------------------------- |
| `account`    | when the flow has `account` params    | the flow's `account`       |
| `ip`         | when the flow has `ip` params         | the flow's `ip`            |
| `global`     | when `authn.throttle.global` is set   | `global`, counted per flow |
| `account-ip` | never; counted when the flow has `ip` | none                       |
| other kinds  | ignored                               | none                       |

A kind with no params in a flow gates nothing there (for example `reauth` has no `ip`). The `account-ip` row only
keeps the count that the success rule needs.

Rows are keyed by an HMAC of `flow|kind|value` in base64url (D7, SR-19), so no table holds a login or an address.
`MemoryAuthnThrottle` uses a random per-instance secret, so ids do not survive a restart; `DbAuthnThrottle` uses
`authn.audit.hashKey.secret`.

## Flow rules

`StoreAuthnThrottle.rules(params)` turns `ThrottleParams` into util `ThrottleFlowRules`, the same for every store:

| Flow                     | `gates`                                        | `counted`                         | `onSuccess`                                                                 |
| ------------------------ | ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `login`, `mfa`, `reauth` | `account`, `ip` (if the flow has it), `global` | `account-ip` if the flow has `ip` | `lower` `ip` by `account-ip` (if the flow has `ip`); `clear` `account`, `account-ip` |
| `reset`                  | the same                                       | `account-ip` if the flow has `ip` | none: a success clears nothing (§22.13)                                     |

## Success

- `reset` clears nothing; only time does (§22.13).
- Otherwise the `account` and `account-ip` rows are deleted, and a full table's hold-off is released (memory).
- The `ip` row is lowered by the attempts the success spent on this IP (A06, D8): the largest count among the
  `account-ip` rows consumed, never the sum, since several of them counted the same attempts. At 0 the `ip` row is
  deleted, otherwise its delay is recomputed. A login to your own account cannot clear failures spent on other
  accounts. `MemoryAuthnThrottle` subtracts only the `account-ip` rows whose run began after the `ip` row's run;
  `DbAuthnThrottle` rows carry no run, so it subtracts what it consumed.

## Backoff and capacity

After counted attempt `n` on a key, the next attempt waits `0` while `n < free`, and
`min(baseDelayMs × 2^(n − free), maxDelayMs)` once `n ≥ free`. A row expires when it has had no counted attempt
for `resetAfterSeconds` and no delay is running. Table mechanics (sweeping, eviction, the full-table refusal) are
`KeyedBackoff`'s, see the util documentation.

`MemoryAuthnThrottle` gives each flow its own table of at most `authn.throttle.maxRows` rows (default 1,000,000;
memory grows with 4 × `maxRows`). A fresh login attempt adds 3 rows (`account`, `ip`, `account-ip`), 4 with
`authn.throttle.global`. Once per full episode a warning goes to the `authn-throttle` log (`reportFull`); it names
the flow and `maxRows`, never a key.

## Configuration

`authn.throttle.*`, read once at first use, cloned and frozen. The per-flow keys, `resetAfterSeconds`, `global`
and `maxRows` are described in `docs/authn/README.md` (Throttling). `memory` tunes `MemoryAuthnThrottle` only:

| Key                                      | Default | Range     | Meaning                                                  |
| ---------------------------------------- | ------- | --------- | -------------------------------------------------------- |
| `authn.throttle.memory.sweepBatch`       | `8`     | 1 - 1000  | Expired rows checked per attempt.                        |
| `authn.throttle.memory.fullRetrySeconds` | `60`    | 1 - 3600  | `Retry-After` of a full table with no delay to wait for. |
| `authn.throttle.memory.holdOffMs`        | `1000`  | 0 - 60000 | Pause before the next scan of a nearly full table.       |

An unknown key under `memory` fails the boot (the schema also has `propertyNames`, because the app validator
would otherwise strip it silently). `DbAuthnThrottle` ignores `memory`. `DEFAULT_MEMORY_THROTTLE` holds the
defaults; `MemoryThrottleConfig` is the type.

## Dependency injection

- `MemoryAuthnThrottle` is a `@Singleton` registered as an `AuthnThrottle`. `DefaultAuthnService` gets its
  throttle from `selectAuthnThrottle(container, authn.throttle.service)`: the named one; when unset, the only
  registered throttle, or the only one besides `MemoryAuthnThrottle`. An unregistered name, or several
  candidates, fails boot. It never falls back to memory.
- Each flow's table is a `FlowLimiter` (a `KeyedBackoff` plus its `flow`), `@NewInstance`, resolved by
  `DI.resolve(FlowLimiter, [flow, options])` from the root container, matching the throttle's lifetime. The first
  use of any flow resolves all four and caches them per flow.
- To replace the limiter of every flow, register a subclass as `FlowLimiter`. It must keep the `(flow, options)`
  constructor (DI passes resolved constructor dependencies before those arguments) and take its own dependencies
  through property injection. A subclass with any DI decorator, such as `@Autoinject`, must declare
  `@NewInstance()` again: the decorator gives the subclass its own descriptor, a singleton, so one instance would
  serve every flow. The throttle checks what DI returns: an instance shared between flows, one of another flow, or
  anything but a `FlowLimiter` (an `AsyncService` dependency makes it a Promise) fails each call that needs a
  limiter with `InvalidOperation`, from the first attempt on.
- `MemoryAuthnThrottle` keeps `delayMs`, `keyId` and `reportFull` protected for subclasses and tests. `limiter(flow)`
  is a read/patch seam for tests: overriding it does not steer the throttle. The delay formula stays in
  `@spinajs/authn/contracts`, which may import only `@spinajs/di`.

## Choosing a store

|                  | `MemoryAuthnThrottle`                   | `DbAuthnThrottle`                |
| ---------------- | --------------------------------------- | -------------------------------- |
| Scope            | one process; each instance counts apart | all instances, over the database |
| Restart          | forgets every row                       | keeps rows                       |
| Capacity         | `maxRows` per flow, eviction            | the table                        |
| Key hash         | random per-instance secret              | `authn.audit.hashKey.secret`     |
| Sub-second delay | yes                                     | not on MySQL and MSSQL           |

Use the memory throttle for development, tests and a single instance that is not internet-facing. Behind a load
balancer or with several instances, use `DbAuthnThrottle`, or a store of your own (below).

## A throttle on a new store

Extend `StoreAuthnThrottle` (also at `@spinajs/authn/store-throttle`, which registers nothing in DI) and implement:

- `params`: the `ThrottleParams`, read once, after `store()`;
- `store()`: the `ThrottleStore` (see "Writing a store" in the util documentation), built lazily, once; a failed
  build is not kept;
- `keyId(flow, key)`: an opaque id that never holds the plain key value (SR-19).

Optionally override `rules(params)`, `checkKeys`, `nowMs` and `throttleName`. Register the class with
`@Injectable(AuthnThrottle)` and name it in `authn.throttle.service`. `ctx.now` and the flow are checked before
`params` is read or the store built.
