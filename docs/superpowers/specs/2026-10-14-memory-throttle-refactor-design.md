# Memory throttle refactor — design

Resolves the review TODOs in `packages/authn/src/throttle/memory-throttle.ts`:

- move the generic throttle code into `@spinajs/util` and build the auth throttle on it;
- move the constants into config;
- one limiter per flow, resolved through DI, instead of a hard-coded table map;
- a README in `packages/authn/src/throttle/` with the full spec, flow and behaviour.

User decisions (2026-10-14):

- per-flow limiters behind the unchanged `AuthnThrottle` contract (DbAuthnThrottle and all callers untouched);
- the constants become `authn.throttle.memory.*`; `authn.throttle.maxRows` stays where it is.

## 1. `@spinajs/util`: `KeyedBackoff`

New file `packages/util/src/resilience/keyed-backoff.ts`, exported from the resilience index. It is a per-key backoff table kept in memory and knows nothing about authn. Keys are opaque strings, and the caller hashes them.

```ts
export interface BackoffParams { readonly free: number; readonly baseDelayMs: number; readonly maxDelayMs: number }

/** The wait after counted attempt n (1-based): 0 until n reaches free, then min(baseDelayMs × 2^(n − free), maxDelayMs). */
export function backoffDelayMs(p: BackoffParams, n: number): number;

export interface KeyedBackoffGate { readonly key: string; readonly backoff: BackoffParams }

export type KeyedBackoffVerdict = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface KeyedBackoffRow {
  attempts: number;
  /** Stamped from a per-table counter when the row is created: a decayed or evicted key starts a new run. */
  readonly run: number;
  /** The gate's `free`; Infinity for a counted key that gates nothing. Decides the eviction tier. */
  readonly free: number;
  lastMs: number;
  /** 0 when the key does not delay. */
  nextMs: number;
}

export interface KeyedBackoffOptions {
  readonly maxRows: number;          // integer >= 1
  readonly resetAfterMs: number;     // > 0; a row with no counted attempt this long, and no running delay, expires
  readonly sweepBatch?: number;      // default 8; expired rows checked per attempt
  readonly fullRetryMs?: number;     // default 60_000; Retry-After when a full table has no delaying row to wait for
  readonly holdOffMs?: number;       // default 1000; pause before the next scan while the table stays nearly full
  readonly delay?: (p: BackoffParams, n: number) => number; // default backoffDelayMs (a test seam)
  readonly onFull?: () => void;      // once per full episode; a throw is swallowed and the call retried on the next scan
}

export class KeyedBackoff {
  constructor(options: KeyedBackoffOptions);
  /** Refuses with the longest running delay among `gates`; otherwise makes room and counts every gate and every `counted` key. Synchronous: no interleaving. */
  attempt(gates: readonly KeyedBackoffGate[], counted: readonly string[], nowMs: number): KeyedBackoffVerdict;
  /** Like attempt for a delay, counting nothing; a full table does not refuse. */
  peek(gates: readonly KeyedBackoffGate[], nowMs: number): KeyedBackoffVerdict;
  /** Sweeps up to `batch` rows (default sweepBatch); a caller with several tables spreads sweeps across them. */
  sweep(nowMs: number, batch?: number): void;
  /** The live row, or undefined; expires it first when stale. */
  row(key: string, nowMs?: number): KeyedBackoffRow | undefined;
  delete(key: string): boolean;
  /** Clears the full hold-off (a success frees the table at once). */
  release(): void;
  readonly size: number;
  /** Read-only view, oldest last attempt first (tests, diagnostics). */
  entries(): IterableIterator<[string, Readonly<KeyedBackoffRow>]>;
}
```

The behaviour is carried over exactly from today's `MemoryAuthnThrottle`:

- The order of rows is the order of last attempts; counting a key re-inserts its row.
- A row is stale when `now − lastMs ≥ resetAfterMs` and its delay has ended. Idle time alone never cuts a running delay short.
- Making room in a full table:
  - The scan target is `maxRows − max(needed, ceil(maxRows / 100))`.
  - Tier 1 evicts rows that are stale or below their `free`.
  - Tier 2 evicts any row that is not delaying.
  - A row that is delaying is never evicted.
  - If room is still short, the table refuses until the first delay ends, or for `fullRetryMs` when nothing is delaying. `onFull` is called once per full episode.
  - When it ends up just short of the target, it holds off the next scan for `min(firstFree, now + holdOffMs)`.
- An invalid option throws `InvalidArgument` from `@spinajs/exceptions`, which is already a util dependency. So does a non-finite `nowMs`.

`@spinajs/authn/contracts` keeps its own `BackoffParams` and `backoffDelayMs` (structurally identical to util's): the contracts boundary allows only `@spinajs/di` (`test/contracts/boundary.test.ts`, frozen API). MemoryAuthnThrottle passes its `delayMs` seam, which uses the contracts formula, as the limiter's `delay`, so authn keeps one formula source.

## 2. authn: `FlowLimiter`, resolved per flow

New file `packages/authn/src/throttle/flow-limiter.ts`:

```ts
@NewInstance()
@Injectable()
export class FlowLimiter extends KeyedBackoff {
  constructor(public readonly flow: ThrottleFlow, options: KeyedBackoffOptions) { super(options); }
}
```

`MemoryAuthnThrottle`:

- **Limiters.** On the first use of any flow it builds all four limiters through `DI.resolve(FlowLimiter, [flow, options])`. That is the root container, matching the throttle's `@Singleton` lifetime. The limiters are cached per flow. An app replaces the limiter for every flow by registering a `FlowLimiter` subclass; a subclass with any DI decorator must declare `@NewInstance()` again, and the throttle throws `InvalidOperation` when DI returns anything but a distinct `FlowLimiter` of each flow.
- **Options** come from config: `maxRows`, `resetAfterSeconds × 1000`, `authn.throttle.memory.*`, the `delayMs` seam, and `onFull`, which calls `reportFull(flow)`.
- **Authn-specific logic it keeps:**
  - **Gates per key kind:** `account` and `ip` use the flow's params; `global` uses `params.global`. An `account-ip` key is counted without gating when the flow has `ip` params.
  - **Key ids:** `HMAC-SHA256(per-instance secret, flow|kind|value)`, base64url (D7).
  - **Sweeping:** before each attempt it sweeps the attempt's own flow with a full batch and every other flow with `ceil(batch / 4)`.
  - **`succeed`:**
    - `reset` clears nothing.
    - Otherwise it releases the hold-off, deletes the `account` and `account-ip` rows, and lowers the `ip` row by the largest attempt count among `account-ip` runs that began after the `ip` row's run (`a.run > row.run`; an older `account-ip` run counted attempts the `ip` row never saw) (D8). It then recomputes that row's `nextMs`, or deletes the row at 0.
  - **Validation:** unknown flow → `InvalidArgument`; a key value that is not a string → `InvalidArgument`.
  - **Config:** read once, cloned and deep-frozen. The `explicit` params and `options.maxRows` constructor arguments stay for tests.
- **Protected seams the tests and mutants use:** `delayMs(p, n)`, `keyId(flow, key)`, `reportFull(flow)` and `limiter(flow): FlowLimiter`. `limiter(flow)` replaces `tables` and `sweepBatch`. Tests read rows through `limiter(flow).entries()` and `row()`.
  - The `ReadModifyWrite` mutant (non-atomic store) is rewritten on the limiter API, and must still be caught by the suite.

## 3. Config

Schema `authn.throttle` gains `memory` (and `propertyNames` lists it):

```ts
memory: {
  type: 'object', default: {}, additionalProperties: false,
  propertyNames: { enum: ['sweepBatch', 'fullRetrySeconds', 'holdOffMs'] },
  properties: {
    sweepBatch: { type: 'integer', minimum: 1, maximum: 1000, default: 8, description: 'Expired rows a MemoryAuthnThrottle checks per attempt.' },
    fullRetrySeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 60, description: 'Retry-After of a full memory table with no delay to wait for.' },
    holdOffMs: { type: 'integer', minimum: 0, maximum: 60000, default: 1000, description: 'Pause before the next scan of a nearly full memory table.' },
  },
}
```

- `config/authn.ts` and `config-defaults.test.ts` get the same defaults.
- `ThrottleConfig` gains `memory?`.
- DbAuthnThrottle ignores the key.
- `checkThrottleParams` and `checkThrottleMaxRows` in `service/boot/env.ts` stay as they are; that cleanup belongs to phase D.

## 4. Docs

- `packages/authn/src/throttle/README.md` documents:
  - the contract (`attempt`, `succeed`, `peek`/K5) and the key kinds;
  - per-flow gating, the backoff formula and decay;
  - the success rules (A06, D8, `reset`);
  - capacity and eviction, and the hold-off;
  - config `authn.throttle.*` including `memory.*`;
  - DI: `@Singleton`, `FlowLimiter` per flow and how to replace it, and how `selectAuthnThrottle` picks a throttle;
  - memory vs `DbAuthnThrottle`.
- `packages/util` README: a short `KeyedBackoff` section, if a README with resilience docs exists; otherwise the class JSDoc.
- RELEASE_NOTES:
  - util `KeyedBackoff` and `backoffDelayMs`;
  - authn `FlowLimiter`, the `authn.throttle.memory.*` keys, and the removed `ThrottleRow`/`ThrottleTable` exports.
- API snapshot updated if it changes.

## 5. Testing

- **util:** `test/keyed-backoff.test.ts` covers:
  - backoff and decay;
  - several gates refusing with the longest wait;
  - `counted` keys;
  - eviction tiers;
  - never evicting a delaying row;
  - the full hold-off;
  - `onFull` called once, and a throw in it swallowed;
  - `peek` counting nothing;
  - `release`;
  - invalid options.
- **authn:** `memory-throttle.test.ts` keeps every behavioural case. Internals access moves to `limiter(flow)`. The mutation suite (`test/mutation/throttle-mutants.ts`) still kills every mutant.
- **authn:** a new test checks that a registered `FlowLimiter` subclass is used per flow, and that `authn.throttle.memory.*` reaches the limiter.
- **Unchanged and must stay green:** authn-orm throttle tests, authn-testing A05/A06 behaviour specs, default-authn-service tests.

## Out of scope

- DbAuthnThrottle internals.
- Phase D (env.ts / check-config schema move).
- The ~15 `deepFreeze` copies in other packages.
