# Async helpers, caches and graphs

Building blocks for services that load things lazily, cache them, serialise work, run work in the background and walk small graphs. None of them depends on Node: they run in any JavaScript runtime with `setTimeout`.

## Async helpers

| Export | Behaviour |
| --- | --- |
| `onceAsync(fn)` | Returns a function that runs `fn` once and shares its promise. A rejection is not kept: the next call runs `fn` again |
| `memoizeAsync(map, key, load)` | The promise under `key` in `map`, or `load()` stored there. A rejected promise is removed; a fulfilled one stays |
| `singleFlight(map, key, load)` | Concurrent calls for `key` share the load in flight; once it settles, either way, it is removed |
| `KeyedMutex<K>` | `runExclusive(key, fn)` runs tasks one at a time per key, in call order. A failed task does not block the next; idle keys are forgotten (`size`) |
| `TaskTracker` | `defer(work)` runs `work` on a later turn of the event loop; its error goes to the `onError` passed to the constructor (default `console.error`). `drain()` waits for everything deferred so far, including work deferred while draining |
| `settleWithin(p, ms)` | Waits at most `ms` for `p` and never rejects: `{ status: 'fulfilled', value }`, `{ status: 'rejected', reason }` (with `brokenThenable: true` when `then()` itself threw) or `{ status: 'timeout' }` |
| `Deadline` | One time limit shared by several steps. `new Deadline(ms)` starts the timer; `race(work)` answers `work`'s result or `Deadline.EXPIRED`; `expired` tells whether the limit passed; `clear()` stops the timer |

`memoizeAsync` and `singleFlight` take any object with `get`, `set` and `delete`, so a `Map`, a `BoundedMap` or an `LruTtlCache` can hold the promises.

```ts
const keys = new BoundedMap<string, Promise<CryptoKey>>(100);
const key = await memoizeAsync(keys, kid, () => importKey(kid));

const links = new KeyedMutex<string>();
await links.runExclusive(userId, () => unlink(userId, provider));
```

Neither `settleWithin` nor `Deadline` cancels the work it waits for; a result that comes later is ignored and its rejection caught.

## `RefreshingCache<T>`

One value loaded on first use and reloaded when it is older than `maxAgeMs`. Concurrent callers share one load. A failed load keeps serving the last good value.

| Option | Default | Meaning |
| --- | --- | --- |
| `load(now)` | required | Fetches a new value |
| `maxAgeMs` | required | How long a value is served without a reload |
| `retryAfterFailureMs` | `0` | After a failed load, the next one waits this long |
| `minIntervalMs` | `0` | Loads start at most this often, whether they succeed or not |
| `clock` | wall clock | Supplies `now` when a call passes none |
| `onRefresh(value)` | none | Called with each newly loaded value |
| `coolingDownError()` | generic `Error` | The rejection when a load is held back and there is no value yet |

`get(now?)` serves a fresh value or reloads. `refresh(now?)` reloads regardless of age. Both join a load in flight and, while loads are held back, serve the last good value. `value` and `fetchedAt` read the last good value and its load time. A time that is not finite rejects with `InvalidArgument`.

```ts
const discovery = new RefreshingCache({
  load: () => fetchJson(`${issuer}/.well-known/openid-configuration`),
  maxAgeMs: 3_600_000,
  retryAfterFailureMs: 60_000,
});
const metadata = await discovery.get();
```

## Caches

### `LruTtlCache<K, V>`

A least-recently-used cache whose entries expire and can be dropped by tag.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxEntries` | required | Entries held at most, an integer `>= 0`; 0 holds nothing |
| `ttlMs` | none | TTL of an entry set without one; without either, the entry never expires |
| `clock` | wall clock | Times the TTL |
| `expireOnClockRewind` | `false` | An entry stored at a later clock time than now (the clock went back) counts as expired |
| `onEvict(key, value, reason)` | none | Called for every entry that leaves: `expired`, `capacity`, `replaced`, `invalidated`, `deleted` or `cleared` |

`set(key, value, { ttlMs?, tags? })` stores an entry. A `ttlMs` that is not a finite number above 0, or a clock that answers an invalid date, stores nothing (and still drops the old entry). `get` marks the entry as most recently used; `peek` and `has` do not. `invalidate(tags)` drops every entry with any of the tags. `size` counts expired entries that were not read since.

### `BoundedMap<K, V>`

A map holding at most `max` entries (an integer `>= 1`). A new key set when full drops the oldest key, first in first out; setting a key already held keeps its place. Use it for maps keyed by request data.

## `Clock`

`Clock` is an abstract class with one method, `now(): Date`; extend it for a DI token, or pass any `{ now(): Date }` object. `SystemClock` tells the wall time. `ManualClock` (for tests) starts at the date you give it (default the epoch) and moves only through `advance(ms)` and `set(date)`.

## `ListenerSet<T>`

`add(fn)` subscribes and returns the unsubscribe function; adding one function twice makes two subscriptions. `emit(value)` calls the listeners present when it started, in the order they were added, without awaiting them. A listener's throw or rejected promise goes to the `onError` passed to the constructor (default `console.error`) and never stops the others.

## Graphs

Both functions take the nodes, a function listing a node's out-edges, and an optional `targetOf(edge)`; without it, edges are the nodes they lead to.

- `findCycle(nodes, edgesOf, targetOf?)` returns the first cycle a depth-first search meets, as `{ nodes, edges }`: `nodes` ends where it starts and `edges[i]` leads from `nodes[i]` to `nodes[i + 1]`. It answers `undefined` for an acyclic graph. The search is iterative, so a deep graph cannot overflow the stack.
- `reachable(start, edgesOf, targetOf?)` returns `start` and every node reachable from it, in breadth-first order.

```ts
const cycle = findCycle(roles.keys(), (r) => edges.get(r)!, (e) => e.to);
if (cycle) throw new Error(`role cycle: ${cycle.nodes.join(' -> ')}`);
```
