# Resilience

A composable resilience toolkit modelled after [Polly](https://www.pollydocs.org/). You build a **pipeline** of strategies (retry, timeout, circuit breaker, fallback, hedging, concurrency limiter) and execute an operation through it. Strategies wrap each other like middleware.

```ts
import {
  ResiliencePipelineBuilder,
  PredicateBuilder,
  BackoffType,
  TimeSpan,
} from '@spinajs/util';
```

## Quick start

```ts
const pipeline = new ResiliencePipelineBuilder<Buffer>()
  .addTimeout(TimeSpan.fromSeconds(10))
  .addRetry({ MaxRetryAttempts: 3, BackoffType: BackoffType.Exponential, UseJitter: true })
  .build();

const data = await pipeline.execute(() => downloadAsync());
```

The pipeline is **reusable and shareable** across calls. Stateful strategies (the circuit breaker's health window, the concurrency limiter's permits) keep their state between executions, which is exactly what you want — build the pipeline once, execute many times.

## Execution model & ordering

Strategies execute in the order added — **first added is outermost**:

```ts
new ResiliencePipelineBuilder()
  .addRetry(...)     // outermost — sees the result of the whole timeout+op
  .addTimeout(...)   // innermost — bounds each individual attempt
  .build();
```

So the call above means *"retry the operation, giving **each attempt** its own timeout"*. Flip the order and a single timeout would bound **all** retries together. Ordering is the most important design decision — think about what each layer should observe.

## The execution context & cancellation

`execute(callback, context?)` passes a `ResilienceContext` to your callback:

```ts
interface ResilienceContext {
  Signal: AbortSignal;              // aborted when an outer strategy (e.g. timeout) gives up
  OperationKey?: string;            // logical name for logging/telemetry
  Properties: Map<string, unknown>; // per-execution scratch space
}
```

Long-running operations **should observe `Signal`** so they can stop early instead of running to completion after a timeout already rejected the caller:

```ts
await pipeline.execute((ctx) =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => resolve('done'), 10_000);
    ctx.Signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(ctx.Signal.reason);
    });
  }),
);
```

You can also pass your **own** signal to cancel from the outside:

```ts
const ac = new AbortController();
const p = pipeline.execute(() => longOp(), { Signal: ac.signal, OperationKey: 'sync-users' });
ac.abort(); // cancels retries/delays cooperatively
```

## Deciding what to handle — `PredicateBuilder`

Every strategy takes a `ShouldHandle` option deciding which outcomes it reacts to. Default: **any exception**. Use `PredicateBuilder` for anything richer:

```ts
const shouldHandle = new PredicateBuilder<Response>()
  .handle(NetworkError)                       // errors of a type
  .handle(HttpError, (e) => e.status >= 500)  // ...optionally filtered
  .handleError((e) => (e as any).retryable)   // any error matching a predicate
  .handleResult((r) => r.status === 503)      // a *successful* but bad result
  .handleResultValue(null);                   // a specific result value
```

- An empty builder (or omitting `ShouldHandle`) handles **any error** and no results (Polly's default).
- `handleResult*` lets a strategy treat a returned value as a failure — e.g. retry on an HTTP 503 body that never threw.

You can also pass a raw predicate `(outcome) => boolean | Promise<boolean>` instead of a builder.

---

## Strategies

### Retry — `addRetry(options?)`

Re-runs the operation while the outcome is handled, up to `MaxRetryAttempts` times.

| Option | Default | Notes |
|---|---|---|
| `MaxRetryAttempts` | `3` | total executions = attempts + 1 |
| `Delay` | `2s` | base delay (`TimeSpanLike`) |
| `BackoffType` | `Constant` | `Constant` \| `Linear` \| `Exponential` |
| `UseJitter` | `false` | randomize delay to avoid retry storms |
| `MaxDelay` | — | clamp the computed delay |
| `DelayGenerator` | — | custom per-attempt delay, overrides backoff |
| `ShouldHandle` | any error | what to retry on |
| `OnRetry` | — | callback before each delay |

```ts
new ResiliencePipelineBuilder<string>()
  .addRetry({
    MaxRetryAttempts: 5,
    Delay: TimeSpan.fromMilliseconds(200),
    BackoffType: BackoffType.Exponential, // 200, 400, 800, 1600, ...
    UseJitter: true,                      // spread within a [0.5x, 1.5x) band
    MaxDelay: TimeSpan.fromSeconds(5),    // never wait more than 5s
    ShouldHandle: new PredicateBuilder<string>().handle(IOFail),
    OnRetry: ({ AttemptNumber, RetryDelay }) =>
      console.warn(`retry #${AttemptNumber} in ${RetryDelay.toString()}`),
  })
  .build();
```

**Backoff shapes** (base `d`, attempt `n`, 1-based): `Constant` → `d`; `Linear` → `d·n`; `Exponential` → `d·2^(n-1)`. `MaxDelay` clamps the result; `UseJitter` randomizes it.

Retry on a **bad result** (no exception thrown):

```ts
.addRetry({
  ShouldHandle: new PredicateBuilder<Res>().handleResult((r) => r.statusCode === 503),
})
```

### Timeout — `addTimeout(options | TimeSpanLike)`

Abandons the operation after a duration, rejecting with `TimeoutRejectedException` **and** aborting `ctx.Signal` so cooperative callbacks stop early.

```ts
.addTimeout(TimeSpan.fromSeconds(10))
.addTimeout(5000)                     // shorthand: raw ms
.addTimeout({ Timeout: '00:00:30', OnTimeout: ({ Timeout }) => log(Timeout) })
```

### Fallback — `addFallback(options)`

Supplies a substitute value when the outcome is handled. `FallbackAction` is required and may be async.

```ts
.addFallback({
  ShouldHandle: new PredicateBuilder<User[]>().handle(NetworkError),
  FallbackAction: async ({ Outcome }) => {
    log('serving cached users', Outcome.Error);
    return loadCachedUsers();
  },
  OnFallback: ({ Outcome }) => metrics.increment('fallback'),
})
```

### Circuit breaker — `addCircuitBreaker(options?)`

Stops calling a failing dependency once a failure **ratio** is exceeded, then probes for recovery. State machine: `Closed → Open → HalfOpen → Closed/Open`, plus a manual `Isolated`.

| Option | Default | Notes |
|---|---|---|
| `FailureRatio` | `0.1` | trip when ≥ this fraction fail |
| `MinimumThroughput` | `100` | min samples before evaluating |
| `SamplingDuration` | `30s` | rolling window |
| `BreakDuration` | `5s` | how long it stays open before a trial |
| `ManualControl` | — | external isolate/reset handle |
| `OnOpened`/`OnClosed`/`OnHalfOpened` | — | state transition hooks |

While open, calls reject fast with `BrokenCircuitException`.

```ts
const control = new CircuitBreakerManualControl();

const pipeline = new ResiliencePipelineBuilder<void>()
  .addCircuitBreaker({
    FailureRatio: 0.5,
    MinimumThroughput: 10,
    BreakDuration: TimeSpan.fromSeconds(30),
    ManualControl: control,
    OnOpened: ({ BreakDuration }) => log(`circuit open for ${BreakDuration.toString()}`),
  })
  .build();

// force-open for maintenance; rejects with IsolatedCircuitException until reset()
control.isolate();
control.reset();
```

### Hedging — `addHedging(options?)`

Cuts **tail latency** by racing several attempts, staggered by `Delay`; the first non-handled outcome wins and the losers are aborted. A handled failure starts the next hedge immediately.

| Option | Default | Notes |
|---|---|---|
| `MaxHedgedAttempts` | `1` | extra attempts beyond the original |
| `Delay` | `2s` | stagger before launching the next hedge |
| `ShouldHandle` | any error | what triggers an immediate extra attempt |
| `ActionGenerator` | re-run pipeline | customize each attempt |

```ts
.addHedging({
  MaxHedgedAttempts: 2,
  Delay: TimeSpan.fromMilliseconds(100), // if no answer in 100ms, fire another
})
```

If **every** attempt fails, the last underlying error is rethrown (or `HedgingException` when there is no error to surface).

### Concurrency limiter — `addConcurrencyLimiter(options | number)`

Bulkhead isolation — bounds how many executions run at once. Extra calls queue up to `QueueLimit`, then reject with `RateLimiterRejectedException`.

```ts
.addConcurrencyLimiter(10)                          // shorthand: PermitLimit = 10
.addConcurrencyLimiter({ PermitLimit: 10, QueueLimit: 20 })
```

`PermitLimit` running + `QueueLimit` waiting is the ceiling; the next call is rejected immediately. Queued calls that are cancelled (their `ctx.Signal` aborts) leave the queue cleanly.

---

## Composing a realistic pipeline

Order, outermost → innermost:

```ts
const http = new ResiliencePipelineBuilder<Response>()
  .addConcurrencyLimiter({ PermitLimit: 20, QueueLimit: 50 }) // protect the pool
  .addCircuitBreaker({ FailureRatio: 0.5, MinimumThroughput: 20 }) // stop hammering a dead dep
  .addRetry({ MaxRetryAttempts: 3, BackoffType: BackoffType.Exponential, UseJitter: true })
  .addTimeout(TimeSpan.fromSeconds(2)) // per-attempt deadline
  .build();

const res = await http.execute((ctx) => fetchWithSignal(url, ctx.Signal), { OperationKey: 'GET /users' });
```

Reading it: at most 20 concurrent calls; if the dependency is failing, the breaker short-circuits; otherwise retry with exponential backoff + jitter; and every single attempt is bounded to 2 seconds (the timeout aborts the fetch via `ctx.Signal`).

## Custom strategies — `addStrategy`

A strategy is just `(next) => (ctx) => Promise<T>`. Add your own:

```ts
const logStrategy = (next) => async (ctx) => {
  const start = Date.now();
  try {
    return await next(ctx);
  } finally {
    log(`${ctx.OperationKey} took ${Date.now() - start}ms`);
  }
};

new ResiliencePipelineBuilder().addStrategy(logStrategy).addRetry().build();
```

## Exceptions

| Exception | Thrown by |
|---|---|
| `TimeoutRejectedException` | timeout elapsed |
| `BrokenCircuitException` | breaker is open |
| `IsolatedCircuitException` | breaker manually isolated (subtype of `BrokenCircuitException`) |
| `RateLimiterRejectedException` | concurrency limit + queue full |
| `HedgingException` | all hedged attempts failed with no error to surface |
| `CanceledException` | an operation/delay was aborted via its signal |

All extend `@spinajs/exceptions`' `Exception` (an `Error`).

## Low-level primitives

The building blocks are exported for advanced use / custom strategies: `Outcome`, `ResilienceStrategy`, `Executor`, `_capture`, `_unwrap`, `_delay`, `_backoff`, `_toTimeSpan`, `_linkSignal`, `_resolveShouldHandle`. See [`resilience/core.ts`](../src/resilience/core.ts).

## Per-key backoff — `KeyedBackoff`

Not a pipeline strategy: an in-memory table of keys that back off on their own, for a single process. It never locks a key, it only makes it wait longer. Keys are opaque strings; the caller hashes them.

```ts
import { KeyedBackoff } from '@spinajs/util';

const limiter = new KeyedBackoff({ maxRows: 100_000, resetAfterMs: 86_400_000 });
const gate = { key: 'user-42', backoff: { free: 5, baseDelayMs: 1000, maxDelayMs: 60_000 } };

const v = limiter.attempt([gate], [], Date.now()); // { allowed: true } or { allowed: false, retryAfterSeconds }
```

- `attempt(gates, counted, nowMs)` refuses with the longest running delay among `gates`; otherwise it counts every gate and every `counted` key (a key that is counted but gates nothing). `peek` answers the same without counting. After counted attempt `n` the wait is `backoffDelayMs(p, n)`: `0` while `n < free`, then `min(baseDelayMs × 2^(n − free), maxDelayMs)`.
- A row with no counted attempt for `resetAfterMs` and no running delay expires. When the table is full, rows that delay nobody are evicted, oldest first; a delaying row never is, and attempts that need a new row are refused until one frees (`onFull` fires once per episode).
- Eviction goes in two tiers: expired rows and rows below their `free` first, then any row that is not delaying. `sweep(nowMs, batch?)`, `row`, `delete`, `lower` (takes attempts off a row and recomputes its delay) and `release` (lifts the full-table hold-off) serve callers with their own rules; the remaining options (`sweepBatch`, `fullRetryMs`, `holdOffMs`, `delay`, `onFull`) are documented on `KeyedBackoffOptions`.
- Invalid options and a non-finite `nowMs` throw `InvalidArgument`.

`@spinajs/authn` builds `MemoryAuthnThrottle` on it, one `KeyedBackoff` per flow.

## Per-key backoff over a store — `Throttle`, `ThrottleStore`, `MemoryThrottleStore`

`Throttle` is `KeyedBackoff`'s rule layer over pluggable storage. It decides which ids gate and which are counted; a `ThrottleStore` keeps the rows. Like `KeyedBackoff`, it never locks a key: a key only waits longer. `MemoryThrottleStore` is the in-process store (one `KeyedBackoff` per flow). A multi-instance app supplies its own store; `@spinajs/authn-orm` has one over SQL (`DbThrottleStore`).

```ts
import { MemoryThrottleStore, Throttle } from '@spinajs/util';

const login = { free: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };
const throttle = new Throttle({
  flows: {
    signin: {
      gates: { account: login },
      counted: ['account-ip'],
      onSuccess: { clear: ['account', 'account-ip'] },
    },
  },
  store: new MemoryThrottleStore({ flows: ['signin'], maxRows: 100_000, resetAfterMs: 86_400_000 }),
});

const keys = [{ kind: 'account', value: 'alice' }, { kind: 'account-ip', value: 'alice|192.0.2.1' }];
const v = await throttle.attempt(keys, 'signin', Date.now()); // { allowed: true } or { allowed: false, retryAfterSeconds }
await throttle.succeed(keys, 'signin', Date.now());
```

### Throttle

- A flow is a `ThrottleFlowRules`: `gates` (key kind to `BackoffParams`), `counted` (kinds counted without gating) and `onSuccess` (`lower` and `clear`). Kinds the rules do not name are ignored, so a flow may be given keys it does not use.
- Each key becomes an id with `keyId(flow, key)`; the default is `${flow}|${kind}|${value}`. Pass your own to hash: util does not touch `node:crypto`, and a store should not keep raw logins or addresses. Ids are de-duplicated; an id that is both gating and counted is a gate.
- `attempt` and `peek` build the gates (`peek` counts nothing). `succeed` builds the `lower` rules and the `clear` ids and makes one store call, even with no matching key, since a store may also end a full-table refusal there. A flow without `onSuccess` makes no call.
- Every argument is checked before the store is called: an unknown flow, a non-finite `nowMs`, or a non-string `value` of a key the operation uses throws `InvalidArgument`. A rule that lowers a kind the flow does not gate fails in the constructor. Rules are copied and frozen. `name` prefixes the error messages.

### Writing a store

A `ThrottleStore` has three methods. Ids are opaque; the store does not know kinds. Ids are unique per flow (the caller's `keyId` includes the flow), so a store may ignore the `flow` argument, as `DbThrottleStore` does; one that shares a keyspace across flows must namespace by it. `resetAfter` below is the store's own configuration and must equal the throttle's decay (`authn.throttle.resetAfterSeconds` in authn).

- `attempt(flow, gates, counted, nowMs)` must be atomic. If any gate's row has a running delay, refuse with the longest remaining one (`retryAfterSeconds` at least 1) and count nothing. Otherwise count every gate (attempt `n + 1`, next allowed time `backoffDelayMs(backoff, n + 1)` after `nowMs`) and every `counted` id. Two parallel attempts must not both pass a check only one may pass: of N parallel attempts on a fresh key exactly `free` run, then one per delay slot. Like `succeed`, a store may err only towards more throttling: `DbThrottleStore` uses per-key compare-and-set with undo, and a lost undo keeps a refused attempt's count.
- `peek(flow, gates, nowMs)` is the same delay check, counting nothing.
- `succeed(flow, lower, clear, nowMs)` is one call per success. Apply it without interleaving where the store can (memory). Otherwise go row by row with compare-and-set: a lost race must only leave a row higher (more throttling), never lower.
- `lower` semantics: for each rule in order, consume (delete) its `by` rows and lower each target by the largest count among them, never the sum, since several `by` rows of one success counted the same attempts. A store that can tell a `by` row began after its target (`MemoryThrottleStore` compares runs) subtracts only those; one that cannot (`DbThrottleStore`) subtracts the largest count it consumed. A target that reaches 0 is deleted; otherwise its delay is recomputed from its last attempt with its own backoff. `clear` rows are deleted after all rules.
- Expiry: a row with no counted attempt for `resetAfter` and no running delay is as good as absent, and the store may purge it. A running delay is never cut short by idle time.
- Capacity is the store's business. `MemoryThrottleStore` evicts rows that delay nobody and refuses attempts that need a new row when none can go; a table store can leave it to the database.

Sketch of a Redis store: one hash per row (`attempts`, `lastAt`, `nextAt`) with `PEXPIREAT max(lastAt + resetAfter, nextAt)` set on every write, which matches the expiry rule exactly (a longer TTL would keep expired rows, so the script would have to apply the rule itself). `attempt` is one Lua script that reads every gate, returns the longest wait, or increments all gates and counted rows, so it is atomic across keys. On Redis Cluster a multi-key script needs all keys of one call in one hash slot, for example with hash tags such as `{flow}`; the keys of one attempt are only guaranteed to share the flow. `succeed` is one Lua script too: it reads and deletes the `by` rows, lowers or deletes the targets, deletes the `clear` rows. Peek is a read-only script.

`MemoryThrottleStore` details: it needs the list of `flows` (an unknown flow throws), builds one `KeyedBackoff` per flow lazily so traffic in one flow never evicts another's rows, and each `attempt` also sweeps a quarter of `sweepBatch` from every other flow. `limiter(flow)` exposes a flow's table for tests; the optional `limiter` factory must return a new `KeyedBackoff` per flow, and a shared or foreign instance fails with `InvalidOperation`. A full table refuses only `attempt`, never `peek`.

`@spinajs/authn` builds `MemoryAuthnThrottle` and `StoreAuthnThrottle` on these; see `packages/authn/src/throttle/README.md`.
