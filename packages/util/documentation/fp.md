# Functional / promise helpers (`fp`)

Small combinators for composing async pipelines. Each returns a function you can chain, so you can express a flow declaratively instead of nesting `.then()` calls.

```ts
import { _chain, _zip, _map, _use, _tap, _either, _catch } from '@spinajs/util';
```

## `_chain(...fns)`

Runs values/functions/promises in sequence, threading each result into the next. Non-function values are passed through; functions receive the previous result.

```ts
const result = await _chain(
  () => loadUser(id),
  (user) => enrichProfile(user),
  (profile) => ({ ...profile, loadedAt: Date.now() }),
);
```

## `_zip(...fns)` and `_map(cb)`

`_zip` runs several functions against the **same** input in parallel; `_map` applies a callback across an **array** in parallel:

```ts
const [user, prefs] = await _zip(loadUser, loadPrefs)(userId);

const pages = await _map((url: string) => fetchPage(url))(urls);
```

## `_use(factory, name)`

Runs a factory and merges its result onto the accumulator under `name` — useful to build up a context object step by step:

```ts
const ctx = await _chain(
  _use(() => openDb(), 'db'),
  _use(() => loadConfig(), 'config'),
); // { db, config }
```

## `_tap(fn)`

Runs a side effect but forwards the **original** value (great for logging/metrics mid-chain):

```ts
await _chain(
  () => loadOrder(id),
  _tap((order) => audit.log('loaded', order)),
  (order) => ship(order),
);
```

## `_either(cond, onTrue, onFalse)`

Branching. `cond` may be sync or return a promise:

```ts
const handler = _either(
  (user) => user.isAdmin,
  (user) => adminDashboard(user),
  (user) => userDashboard(user),
);
```

## Error handling

```ts
_catch(fn, onError)                       // catch any error -> onError
_catchException(fn, onError, ErrorType)   // catch only errors of a type (else rethrow)
_catchFilter(fn, onError, (e) => bool)    // catch only errors matching a predicate
_catchValue(fn, onError, value)           // catch only when err === value
_fallback(fn, (err) => substitute)        // replace a rejection with a value
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
_all()        // await an array of promises (or pass a single promise through)
_to_array()   // wrap a value as an array if it isn't one
```

> These `_fp` combinators focus on **async control flow**. For guarding operations with retry/timeout/circuit-breaker semantics, use the [resilience](./resilience.md) pipeline instead.
