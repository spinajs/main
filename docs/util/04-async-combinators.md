# Async combinators

Small functions that compose async steps into a flow without nested `.then()` calls. Most return a step: a function of the previous result that you pass to `_chain` or `_pipe`. For retries, timeouts and circuit breaking use the [resilience pipeline](07-resilience-pipeline.md) instead.

## How it works

1. `_chain(...steps)` starts from `null` and runs the steps in order. `_pipe(...steps)` returns a reusable function that starts from its argument.
2. Each step is handled by type:
   - a function is called with the previous result; a returned promise is awaited;
   - a promise is awaited and its value replaces the previous result;
   - any other value replaces the previous result.
3. The first rejection skips the remaining steps and rejects the whole chain.

```ts
const total = await _chain(
  () => loadOrder(orderId),
  _tap((order: Order) => audit.log('loaded', order.id)),
  (order: Order) => order.lines,
  _map((line: Line) => priceLine(line)),
  _reduce((sum: number, price: number) => sum + price, 0),
);
```

## Combinators

### Composition and collections

| Combinator | Returns | Behaviour |
| --- | --- | --- |
| `_chain<T>(...steps)` | `Promise<T>` | Runs the steps now, starting from `null` |
| `_pipe<T>(...steps)` | `(arg?) => Promise<T>` | Lazy `_chain`; the argument feeds the first step |
| `_zip(...fns)` | `(val) => Promise<[...]>` | Calls every function with the same value in parallel; resolves a typed tuple |
| `_map(cb)` | `(arr) => Promise<R[]>` | Maps every element in parallel |
| `_filter(pred)` | `(arr) => Promise<T[]>` | Keeps elements whose (async) predicate is truthy; order kept |
| `_reduce(reducer, initial)` | `(arr) => Promise<R>` | Reduces serially, in order |
| `_sequence(cb)` | `(arr) => Promise<R[]>` | Maps one element at a time |
| `_concurrent(cb, n)` | `(arr) => Promise<R[]>` | Maps with at most `n` callbacks running; result order matches input order |
| `_batch(size)` | `(arr) => T[][]` | Splits into arrays of at most `size` elements (synchronous) |
| `_all()` | `(val) => Promise` | `Promise.all` for an array, `Promise.resolve` for anything else |
| `_race(...fns)` | `(val) => Promise<R>` | Calls every function with the value; settles with the first to settle |
| `_use(factory, name)` | `(acc?) => Promise<acc & { [name] }>` | Awaits `factory()` and merges the result into the accumulator object under `name` |
| `_to_array()` | `(val) => T[]` | Wraps a single value in an array; arrays pass through |

### Branching

| Combinator | Behaviour |
| --- | --- |
| `_either(cond, onTrue, onFalse?)` | Calls `onTrue(arg)` or `onFalse(arg)`; resolves `null` when `cond` is falsy and `onFalse` is missing |
| `_when(cond, fn)` | Calls `fn(arg)` when `cond` is truthy, otherwise passes `arg` through |
| `_unless(cond, fn)` | Calls `fn(arg)` when `cond` is falsy, otherwise passes `arg` through |
| `_or_else(default)` | Replaces `null` or `undefined` with `default`, or with `default()` when it is a function; `0`, `''` and `false` are kept |
| `_tap(sideEffect)` | Runs a function or awaits a promise, then passes the input through unchanged |

### Error handling

Each wraps a function and returns a function with the same arguments. Synchronous throws in the wrapped function become rejections, so the handler always runs.

| Combinator | Handles | Handler receives |
| --- | --- | --- |
| `_catch(fn, onError)` | Every error | `(err, ...args)` |
| `_catchException(fn, onError, ErrorClass)` | `err instanceof ErrorClass`; others rethrown | `(err)` |
| `_catchFilter(fn, onError, filter)` | `filter(err)` is true; others rethrown | `(err)` |
| `_catchValue(fn, onError, value)` | `err === value`; others rethrown | `(err)` |
| `_fallback(fn, fallback)` | Every error; resolves with `fallback(err)` | `(err)` |
| `_tapError(fn, onError)` | Every error; awaits `onError`, then rethrows the original | `(err, ...args)` |
| `_finally(fn, cleanup)` | Runs `cleanup()` after success or failure; passes the result through | nothing |

Exported types: `Constructor<T>`, `MaybePromise<T>` (`T | Promise<T>`) and `ChainStep`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Chain step, `(arg?) => unknown` | Not registered in DI; passed by value | The combinators above | Your own step factories | Write a function that returns `(arg) => MaybePromise<R>`; it works in `_chain`, `_pipe`, `_zip`, `_race` and the branching combinators |

### Custom step: run a step through a resilience pipeline

A step factory takes its configuration and returns the step. This one runs any async step through a [resilience pipeline](07-resilience-pipeline.md), so one stage of a chain gets retries without the rest.

```ts sample
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder, _chain, _map, _tap } from '@spinajs/util';

function _resilient<T, R>(pipeline: ResiliencePipeline<R>, step: (arg: T, signal: AbortSignal) => Promise<R>) {
  return (arg: T): Promise<R> => pipeline.execute((ctx) => step(arg, ctx.Signal));
}

const retryTwice = new ResiliencePipelineBuilder<string>().addRetry({ MaxRetryAttempts: 2, Delay: 100, BackoffType: BackoffType.Linear }).build();

async function fetchTitles(urls: string[]): Promise<string[]> {
  return _chain(
    urls,
    _map(
      _resilient(retryTwice, async (url: string, signal) => {
        const res = await fetch(url, { signal });
        return (await res.text()).slice(0, 80);
      }),
    ),
    _tap((titles: string[]) => console.log(`fetched ${titles.length} pages`)),
  );
}

fetchTitles(['https://example.com']).then(console.log, console.error);
```

## Important behaviour

- `_chain` starts from `null`: the first function step receives `null`, not `undefined`.
- A promise passed as a step is already running. When an earlier step fails, its rejection is silenced, never reported.
- `_map`, `_filter`, `_reduce`, `_sequence`, `_concurrent` and `_batch` throw a plain `Error` synchronously when the input is not an array. Inside `_chain` that becomes a rejection; called directly it is a throw.
- `_concurrent` and `_batch` throw at creation when `n` or `size` is not a positive integer.
- `_concurrent` rejects on the first failure, but the other workers keep taking elements until the input runs out.
- `_use` drops a non-object accumulator: after a step that returned a number, `_use` starts a fresh object.
- `_catchFilter`, `_catchValue`, `_catchException` and `_fallback` pass only the error to the handler; `_catch` and `_tapError` also pass the original arguments.

## Best practices

- Use `_sequence` for calls that must not overlap, `_concurrent` to cap load on a dependency, and `_map` only for small inputs.
- Combine `_batch` with `_sequence` to write records in chunks: `_chain(rows, _batch(500), _sequence((b) => repo.insert(b)))`.
- Prefer `_catchException` over `_catch`: errors you did not expect still propagate.

## Patterns and antipatterns

```ts
// Don't: the promise starts before _chain runs, and its failure is lost if loadUser fails first
await _chain(() => loadUser(id), sendWelcomeMail(id));

// Do: pass a function so the step starts after the previous one
await _chain(() => loadUser(id), () => sendWelcomeMail(id));
```

## Examples

### Load a dashboard from several sources with a fallback

```ts sample
import { _catchException, _chain, _either, _or_else, _use, _zip } from '@spinajs/util';

class NotFound extends Error {}

const loadUser = async (id: number) => ({ id, name: 'Ann', isAdmin: id === 1 });
const loadStats = async (_id: number): Promise<number[]> => [3, 5, 8];
const loadBanner = async (): Promise<string | null> => {
  throw new NotFound('no banner');
};

async function dashboard(userId: number) {
  const [user, stats] = await _zip(loadUser, loadStats)(userId);

  return _chain(
    _use(_catchException(loadBanner, () => null, NotFound), 'banner'),
    async (ctx: { banner: unknown }) => ({ ...ctx, user, stats }),
    _either(
      (d: { user: { isAdmin: boolean } }) => d.user.isAdmin,
      (d) => ({ ...d, view: 'admin' }),
      (d) => ({ ...d, view: 'user' }),
    ),
  ).then(_or_else({ view: 'empty' }));
}

dashboard(1).then(console.log, console.error);
```

## Related

- [Resilience pipeline](07-resilience-pipeline.md): retry, timeout, circuit breaker and fallback for one operation.
- [Process helpers](06-process-helpers.md): `sleep`, `withTimeout`, `nextTick`.
