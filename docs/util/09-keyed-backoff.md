# Keyed backoff

`KeyedBackoff` is an in-memory table of keys that each back off on their own, for one process. Use it to slow down repeated attempts per account, IP or token: each counted attempt past a free allowance doubles the wait. It never locks a key; a key only waits longer.

It is not a pipeline strategy. For several flows, pluggable storage or several app instances use [Throttle](10-throttle.md), which runs on top of it.

## How it works

1. `new KeyedBackoff(options)` validates the options and creates an empty table.
2. `attempt(gates, counted, nowMs)` is synchronous, so parallel callers cannot interleave:
   1. De-duplicates `gates` by key (the first backoff wins) and drops `counted` keys that are also gates.
   2. `sweep(nowMs)` checks up to `sweepBatch` rows and deletes expired ones.
   3. Looks up every gate. When any has a running delay, it returns `{ allowed: false, retryAfterSeconds }` with the longest remaining wait, rounded up, at least 1 second. Nothing is counted.
   4. When the table has no room for the new rows it needs, it evicts rows (see below). If it still has no room, it refuses.
   5. Counts each gate: `attempts + 1`, `lastMs = nowMs`, and a new delay `delay(backoff, attempts)` from `nowMs`. Then counts each `counted` key without a delay.
   6. Returns `{ allowed: true }`.
3. `peek(gates, nowMs)` runs step 2.3 only: it counts nothing and a full table does not refuse.

The default delay is `backoffDelayMs(p, n)`: `0` while `n < free`, then `min(baseDelayMs × 2^(n − free), maxDelayMs)`. With `free: 5`, attempts 1 to 4 pass freely, attempt 5 starts a `baseDelayMs` wait, attempt 6 a doubled one.

### Expiry and capacity

- A row expires when it had no counted attempt for `resetAfterMs` **and** has no running delay. A delay longer than `resetAfterMs` runs to its end.
- The table keeps at most `maxRows` rows, ordered by last attempt.
- When an attempt needs new rows in a full table, it evicts rows that delay nobody, oldest first, down to `maxRows − max(needed, ceil(maxRows / 100))` rows: first expired rows and rows still below their `free`, then rows deeper in backoff, which lose their count.
- A row with a running delay is never evicted. When nothing can go, attempts that need a new row are refused until the first delay ends, or for `fullRetryMs` when no row delays. `onFull` fires once per such episode.
- While the table stays nearly full, the next scan waits `holdOffMs`; `release()` ends that wait at once.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `maxRows` | `number` | required | integer `>= 1` | Rows kept at most |
| `resetAfterMs` | `number` | required | finite `> 0` | Idle time after which a row with no running delay expires |
| `sweepBatch` | `number` | `DEFAULT_SWEEP_BATCH` (8) | integer `>= 1` | Rows checked for expiry per attempt |
| `fullRetryMs` | `number` | `60000` | finite `> 0` | Retry-After of a full table with no delaying row |
| `holdOffMs` | `number` | `1000` | finite `>= 0` | Pause before the next eviction scan while the table stays nearly full |
| `delay` | `(p: BackoffParams, n: number) => number` | `backoffDelayMs` | | Delay in ms after counted attempt `n` |
| `onFull` | `() => void` | none | | Called once per full episode; a throw is swallowed and the call retried on the next scan |

A gate is `{ key: string; backoff: BackoffParams }`, and `BackoffParams` is `{ free, baseDelayMs, maxDelayMs }`. Gate backoffs are trusted, not validated.

```ts
const signins = new KeyedBackoff({ maxRows: 100_000, resetAfterMs: 24 * 3600_000, onFull: () => metrics.increment('signin.table_full') });
const gate = { key: hash(`account:${login}`), backoff: { free: 5, baseDelayMs: 1000, maxDelayMs: 60_000 } };
const verdict = signins.attempt([gate], [], Date.now());
```

## API

| Member | Behaviour |
| --- | --- |
| `attempt(gates, counted, nowMs)` | See the flow above; returns `KeyedBackoffVerdict` |
| `peek(gates, nowMs)` | Delay check only |
| `sweep(nowMs, batch?)` | Checks up to `batch` rows for expiry, resuming where the last sweep stopped. Call it from a timer when one process owns several tables |
| `row(key, nowMs?)` | The row, read-only. With `nowMs` an expired row is deleted and `undefined` returned |
| `lower(key, by, backoff)` | Takes `by` attempts off the row and recomputes its delay from its last attempt; deletes it at 0 |
| `delete(key)` | Removes the row |
| `release()` | Ends the full-table hold-off; call it after a success |
| `entries()` | Rows, oldest last attempt first (diagnostics) |
| `size` | Row count |

`KeyedBackoffVerdict` is `{ allowed: true }` or `{ allowed: false; retryAfterSeconds: number }`. `KeyedBackoffRow` has `attempts`, `run` (a sequence number stamped when the row is created), `free` (`Infinity` for a counted key), `lastMs` and `nextMs` (`0` when not delaying).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `KeyedBackoff` | Not registered by util; built with `new`. `@spinajs/authn` registers the subclass `FlowLimiter` as `@NewInstance()` | `KeyedBackoff` | `FlowLimiter` (authn) | Subclass it and override the public methods, calling `super`; hand instances to `MemoryThrottleStore` through its `limiter` factory, see [Custom throttle stores](11-custom-throttle-stores.md#memorythrottlestore-limiter-factory) |
| Delay curve, `delay(p, n)` | Option | `backoffDelayMs` | Linear, stepped, test clocks | Pass a function returning milliseconds; `0` means no delay |
| Full-table notification, `onFull()` | Option | none | | Pass a function that logs or counts; keep it fast and non-throwing |

### Custom delay curve and an audited subclass

The `delay` option changes the curve for every gate. A subclass adds behaviour around the public methods; here it reports refusals, and uses a stepped curve: free attempts, then a fixed ladder.

```ts sample
import { BackoffParams, KeyedBackoff, KeyedBackoffGate, KeyedBackoffOptions, KeyedBackoffVerdict } from '@spinajs/util';

const LADDER_MS = [1_000, 5_000, 30_000, 120_000];

/** No delay for the free attempts, then 1 s, 5 s, 30 s, 2 min, capped at maxDelayMs. */
function ladderDelay(p: BackoffParams, n: number): number {
  if (n < p.free) return 0;
  return Math.min(LADDER_MS[Math.min(n - p.free, LADDER_MS.length - 1)], p.maxDelayMs);
}

class AuditedBackoff extends KeyedBackoff {
  public readonly refusals: { key: string; retryAfterSeconds: number }[] = [];

  constructor(options: KeyedBackoffOptions) {
    super({ ...options, delay: options.delay ?? ladderDelay });
  }

  public override attempt(gates: readonly KeyedBackoffGate[], counted: readonly string[], nowMs: number): KeyedBackoffVerdict {
    const verdict = super.attempt(gates, counted, nowMs);
    if (!verdict.allowed) {
      for (const g of gates) this.refusals.push({ key: g.key, retryAfterSeconds: verdict.retryAfterSeconds });
    }
    return verdict;
  }
}

const passwordResets = new AuditedBackoff({ maxRows: 10_000, resetAfterMs: 3600_000, onFull: () => console.warn('reset table full') });
const gate: KeyedBackoffGate = { key: 'reset:ann@example.com', backoff: { free: 2, baseDelayMs: 1_000, maxDelayMs: 60_000 } };

let now = Date.now();
for (let i = 0; i < 4; i++) {
  console.log(passwordResets.attempt([gate], [], now));
  now += 500;
}
console.log(passwordResets.refusals, passwordResets.row(gate.key));
```

## Important behaviour

- Time is the `nowMs` you pass; the class never reads the clock. Pass `Date.now()` in production and a fake clock in tests. A non-finite `nowMs` throws `InvalidArgument`.
- A refused attempt counts nothing, not even its `counted` keys.
- A counted key never delays; it only keeps a count for `lower`.
- Within one attempt, gates are created before counted keys, so a counted key created with them has a later `run`. `MemoryThrottleStore.succeed` relies on this order.
- `peek` does not sweep and ignores a full table.
- Evicting a row in backoff resets that key's count: under a flood of new keys, an attacker's old count can be lost, but never while its delay runs.
- It is per process: in a cluster each instance has its own table. Use a shared [`ThrottleStore`](11-custom-throttle-stores.md) instead.

## Best practices

- Hash keys before you pass them (`sha256(login)`); rows then hold no raw logins or addresses.
- Size `maxRows` for a flood: rows are small, and a too-small table refuses fresh keys while every row delays.
- Keep `resetAfterMs` at least as long as `maxDelayMs`, so an idle key does not lose its count before its delay could matter.

## Related

- [Throttle](10-throttle.md): flow rules and pluggable storage on top of this table.
- [Custom throttle stores](11-custom-throttle-stores.md): replacing the table per flow in `MemoryThrottleStore`.
- [`@spinajs/authn`](../authn/README.md): `MemoryAuthnThrottle` keeps one `FlowLimiter` per login flow.
