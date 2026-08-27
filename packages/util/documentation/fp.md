# Functional / promise helpers (`fp`)

Small combinators for composing async pipelines. Each returns a function you can chain, so you can express a flow declaratively instead of nesting `.then()` calls.

```ts
import { _chain, _fanout, _map, _use, _struct, _tap, _ifElse, _catch, _rescue, _retry } from '@spinajs/util';
```

## `_chain(...fns)` and `_pipe(...fns)`

`_chain` runs functions in sequence, threading each result into the next. Steps must be functions (sync or async) — wrap plain values in a thunk: `() => value`. Types flow through the chain, so step parameters and the final result are inferred without annotations:

```ts
const result = await _chain(
  () => loadUser(id),
  (user) => enrichProfile(user), // user is typed from the previous step
  (profile) => ({ ...profile, loadedAt: Date.now() }),
);
```

`_pipe` is the lazy variant — it composes the steps into a reusable function whose argument feeds the first step:

```ts
const normalize = _pipe(
  (raw: string) => raw.trim(),
  (s) => s.toLowerCase(),
);
await normalize('  HeLLo  '); // 'hello'
```

## `_rescue(handler)`

Step-shaped error boundary. Placed inside a chain it catches failures from **upstream** steps; the handler's result becomes the recovery value the chain continues with. On success the value passes through and the handler never runs:

```ts
const res = await _chain(
  () => loadFromCache(key),
  _rescue(() => loadFromDb(key)), // only on cache failure
  (v) => v.payload,
);
```

Errors thrown by steps *after* the rescue are not caught by it — place it where the boundary belongs.

## `_fanout(...fns)` and `_map(cb)`

`_fanout` runs several functions against the **same** input in parallel; `_map` applies a callback across an **array** in parallel:

```ts
const [user, prefs] = await _fanout(loadUser, loadPrefs)(userId);

const pages = await _map((url: string) => fetchPage(url))(urls);
```

For serial mapping use `_sequence`, for bounded parallelism `_concurrent`, for chunking `_batch`.

## `_concurrent(cb, concurrency, options?)`

Maps an array with at most `concurrency` callbacks in flight. Options:

- `signal` — cooperative cancellation: when the `AbortSignal` aborts, no new items are claimed and the mapping rejects with the abort reason (in-flight callbacks are not interrupted),
- `failFast` — when `true`, a failed item stops remaining workers from claiming new items. Default `false` (the mapping rejects either way, but remaining items keep processing).

```ts
const res = await _concurrent((id: number) => fetchUser(id), 4, { failFast: true })(ids);
```

## `_use(factory, name)` and `_struct(spec)`

`_use` runs a factory and merges its result onto the accumulator under `name` — useful to build up a context object step by step. The merged value type is inferred, so downstream steps destructure without annotations. When the factory resolves to a function, that function is called and its result is merged instead (lazy producers). A primitive accumulator throws — it would be silently dropped.

```ts
const ctx = await _chain(
  _use(() => openDb(), 'db'),
  _use(() => loadConfig(), 'config'),
  ({ db, config }) => migrate(db, config),
);
```

`_struct` is the parallel, multi-key variant — every field function receives the chain input and all fields resolve concurrently:

```ts
const res = await _chain(
  _use(() => loadCampaign(id), 'campaign'),
  _struct({
    owner: (ctx) => loadOwner(ctx),
    stats: (ctx) => loadStats(ctx),
  }),
); // { campaign, owner, stats } - owner and stats in parallel
```

## `_tap(...fns)`

Runs side effects but forwards the **original** value (great for logging/metrics mid-chain). Steps run sequentially, each fed the previous step's result:

```ts
await _chain(
  () => loadOrder(id),
  _tap(
    (order) => audit.log('loaded', order),
    () => metrics.increment('orders.loaded'),
  ),
  (order) => ship(order),
);
```

## `_ifElse(cond, onTrue, onFalse?)`

Branching. `cond` may be sync or return a promise. When `onFalse` is omitted and the condition is falsy, the input value passes through unchanged:

```ts
const handler = _ifElse(
  (user) => user.isAdmin,
  (user) => adminDashboard(user),
  (user) => userDashboard(user),
);
```

One-sided variants: `_when(cond, fn)` runs `fn` on truthy, `_unless(cond, fn)` on falsy — both pass the value through otherwise.

## `_retry(fn, options?)`, `_timeout(fn, ms)`, `_sleep(ms)`

Thin fp-shaped adapters over the [resilience](./resilience.md) strategies:

```ts
_retry(fn, { attempts: 3, delay: 200, backoff: 'exponential', retryIf: (e) => e instanceof IOFail })
_timeout(fn, 5000)  // rejects with TimeoutRejectedException; the operation itself is NOT interrupted
_sleep(500)         // step: waits, then passes the value through
```

- `_retry` — `attempts` is the total number of attempts including the first (default 3), `delay` is the base delay in ms (default 100), `backoff` is `'fixed'` or `'exponential'`, `retryIf` limits which errors are retried (default: all).
- `_timeout` — plain promises are not cancelable, so the guarded operation keeps running orphaned after the timeout fires.
- For jitter, max delay caps, circuit breakers or hedging use `ResiliencePipelineBuilder` directly.

```ts
const rates = await _chain(
  _retry(() => fetchRates(), { attempts: 3, delay: 200 }),
  (r) => r.eur,
);
```

## Error handling

All handlers receive the error as `unknown` — narrow with `instanceof` before touching `.message`:

```ts
_catch(fn, onError)                       // catch any error -> onError
_catchException(fn, onError, ErrorType)   // catch only errors of a type (else rethrow)
_catchFilter(fn, onError, (e) => bool)    // catch only errors matching a predicate
_catchValue(fn, onError, value)           // catch only when err === value
_fallback(fn, (err) => substitute)        // replace a rejection with a value
_tapError(fn, onError)                    // observe the error, then rethrow it
_finally(fn, cleanup)                     // run cleanup on success and failure
```

```ts
const safe = _catchException(
  () => parsePayload(raw),
  (e) => { log.warn(e); return null; },
  SyntaxError,
); // other errors still propagate
```

## Misc

```ts
_all()       // await an array of promises (or pass a single promise through)
_toArray()   // wrap a value as an array if it isn't one
_orElse(def) // replace null/undefined with a default (plain value or factory)
_race(...fns) // run all fns with the same input, first settled wins
```

## Migration from 2.x

Breaking changes in this major:

- **Steps must be functions** — `_chain(5, fn)` becomes `_chain(() => 5, fn)`; raw promises as steps become `() => promise`. In exchange, types are inferred through the whole chain.
- **Renames**: `_zip` → `_fanout`, `_either` → `_ifElse`, `_or_else` → `_orElse`, `_to_array` → `_toArray`. Old names are removed.
- `_ifElse` without an else branch passes the input through instead of resolving `null`.
- `_use` throws on a primitive accumulator instead of silently dropping it.
- `_tap` is variadic and accepts only functions (the direct-promise variant is gone).
- Error handlers are typed `(err: unknown)` instead of `(err: Error)`.

> These `_fp` combinators focus on **async control flow**. For guarding operations with retry/timeout/circuit-breaker semantics beyond the thin `_retry` / `_timeout` adapters, use the [resilience](./resilience.md) pipeline instead.
