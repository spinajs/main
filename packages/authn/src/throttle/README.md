# Throttle

Backoff for failed authentication, behind the `AuthnThrottle` contract. It never locks an account (H31): a key
only waits longer. `MemoryAuthnThrottle` (this package) serves one process; `DbAuthnThrottle`
(`@spinajs/authn-orm`) serves several. The generic table is `KeyedBackoff` in `@spinajs/util`.

## Contract

- `attempt(keys, flow, ctx)` checks every gating key and counts the attempt in one step. It resolves
  `{ allowed: true }`, or `{ allowed: false, retryAfterSeconds }` when a delay holds: the longest one among the
  gating keys. A refused attempt is counted nowhere (A05, A06). `ctx.now` must be a valid `Date`.
- `peek(keys, flow, ctx)` (`PeekableThrottle`) answers the same way and counts nothing. A full table does not
  refuse it. With a peekable throttle, when every candidate strategy is per-request, `DefaultAuthnService` peeks
  before verify and counts only failures, with `attempt` (K5).
- `succeed(keys, flow)` is the success rule, below.

Flows are `login`, `mfa`, `reset` and `reauth`. They never share rows. Any other flow is an `InvalidArgument`, and
so is a key whose `value` is not a string when the call hashes it: `attempt` and `peek` hash the gating keys,
`attempt` also the `account-ip` key when the flow has `ip`, and `succeed` (outside `reset`) the `account`,
`account-ip` and gating `ip` keys. A key the call does not hash is not checked.

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

Rows are keyed by `HMAC-SHA256(per-instance random secret, flow|kind|value)` in base64url (D7), so no table holds
a login or an address, and ids do not survive a restart.

## Backoff and decay

After counted attempt `n` on a key, the next attempt waits `0` while `n < free`, and
`min(baseDelayMs × 2^(n − free), maxDelayMs)` once `n ≥ free`. `attempt` checks and counts synchronously, so of N
parallel attempts on a fresh key exactly `free` run, then one per delay slot.

A row expires when it has had no counted attempt for `resetAfterSeconds` and no delay is running. Idle time alone
never cuts a running delay short. Each `attempt` sweeps a few rows: `sweepBatch` of its own flow's table and
`ceil(sweepBatch / 4)` of every other flow's table.

## Success

- `reset` clears nothing; only time does (§22.13).
- Otherwise the `account` and `account-ip` rows are deleted, and the hold-off of a full table (below) is released.
- The `ip` row is lowered by the attempts the success spent on this IP (A06, D8): the largest count among the
  `account-ip` rows whose run began after the `ip` row's run. Several `account-ip` rows of one success counted the
  same attempts, so the largest is taken, never the sum. The `ip` delay is recomputed from the lowered count; at 0
  the row is deleted. A login to your own account cannot clear failures spent on other accounts.

## Capacity

Each flow has its own table of at most `authn.throttle.maxRows` rows (default 1,000,000; memory grows with
4 × `maxRows`), so one flow never evicts another flow's rows. A fresh login attempt adds 3 rows (`account`, `ip`,
`account-ip`), 4 with `authn.throttle.global`.

When a table is full and an attempt needs `k` new rows, it scans for room down to
`maxRows − max(k, ceil(maxRows / 100))`:

1. Rows that are expired or below their key's `free` go first, oldest last attempt first.
2. Then any row that is not delaying; such a row loses its count, so its key restarts at `free` attempts.
3. A row that is delaying is never evicted.

If room is still short, attempts that need a new row are refused with `Retry-After` of the earliest end of a
delay, or `fullRetrySeconds` when nothing is delaying. Attempts on existing keys still work. The refusal also
holds the scan off until that time. When the scan frees room but stops short of the slack, the scan is held off
until the earlier of the first delay end and `holdOffMs` from now; until then, attempts that need a new row in a
full table are refused. A success lifts the hold-off.

Once per full episode a warning goes to the `authn-throttle` log (`reportFull`); it names the flow and `maxRows`,
never a key. A logging failure is swallowed and retried on the next scan.

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
  use of any flow resolves all four and caches them per flow. `options` carry `maxRows`,
  `resetAfterSeconds × 1000`, the `memory` keys, the delay formula and the `reportFull` hook.
- To replace the limiter of every flow, register a subclass as `FlowLimiter`. It must keep the `(flow, options)`
  constructor (DI passes resolved constructor dependencies before those arguments) and take its own dependencies
  through property injection. A subclass with any DI decorator, such as `@Autoinject`, must declare
  `@NewInstance()` again: the decorator gives the subclass its own descriptor, a singleton, so one instance would
  serve every flow. The throttle checks what DI returns: an instance shared between flows, one of another flow, or
  anything but a `FlowLimiter` (an `AsyncService` dependency makes it a Promise) fails each call that needs a
  limiter with `InvalidOperation`, from the first attempt on.
- `MemoryAuthnThrottle` keeps `delayMs`, `keyId`, `reportFull` and `limiter(flow)` protected for subclasses and
  tests. The delay formula stays in `@spinajs/authn/contracts`, which may import only `@spinajs/di`; the throttle
  passes it to the limiter as `delay`.

## Memory vs `DbAuthnThrottle`

|                  | `MemoryAuthnThrottle`                   | `DbAuthnThrottle`                |
| ---------------- | --------------------------------------- | -------------------------------- |
| Scope            | one process; each instance counts apart | all instances, over the database |
| Restart          | forgets every row                       | keeps rows                       |
| Capacity         | `maxRows` per flow, eviction as above   | the table                        |
| Key hash         | random per-instance secret              | `authn.audit.hashKey.secret`     |
| Sub-second delay | yes                                     | not on MySQL and MSSQL           |

Use the memory throttle for development, tests and a single instance that is not internet-facing. Behind a load
balancer or with several instances, use `DbAuthnThrottle`.
