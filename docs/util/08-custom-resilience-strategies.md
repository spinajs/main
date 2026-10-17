# Custom resilience strategies

A strategy is a function `(next) => (ctx) => Promise<T>`. Add your own with `ResiliencePipelineBuilder.addStrategy()` to log, measure, cache, or apply a rule the built-in strategies do not have. The building blocks the built-in strategies use are exported for you.

## How it works

1. `ResilienceStrategy<T>` is `(next: Executor<T>) => Executor<T>`, and `Executor<T>` is `(ctx: ResilienceContext) => Promise<T>`.
2. `addStrategy(strategy)` appends it to the builder, at the position where you call it: earlier is outer.
3. Your factory runs **once**, when you call it to create the strategy. Keep per-pipeline state (counters, caches, permits) in its closure.
4. The function `(next) => ...` runs on every `execute()`; the returned executor runs once per call of the outer strategy (a retry around it calls it again).
5. Call `next(ctx)` zero, one or many times. Pass a new context (`{ ...ctx, Signal }`) to give the inner chain its own signal.

The built-in `add*` methods are shortcuts: `addRetry(o)` is `addStrategy(retryStrategy(o))`. The factories `retryStrategy`, `timeoutStrategy`, `fallbackStrategy`, `circuitBreakerStrategy`, `hedgingStrategy` and `concurrencyLimiterStrategy` are exported too.

## Primitives

| Export | Signature | Use |
| --- | --- | --- |
| `_capture(exec, ctx)` | `Promise<Outcome<T>>` | Runs an executor and returns `{ Result }` or `{ Error }`, never rejects |
| `_unwrap(outcome)` | `T` | Returns `Result` or throws `Error` |
| `_resolveShouldHandle(shouldHandle?)` | `ShouldHandlePredicate<T>` | Turns a `PredicateBuilder`, a function or nothing (any error) into a predicate |
| `_toTimeSpan(value, fallback)` | `TimeSpan` | Normalizes a `TimeSpanLike` option, `fallback` when empty |
| `_delay(ts, signal?)` | `Promise<void>` | Waits; rejects with the abort reason when `signal` aborts |
| `_abortReason(signal?)` | `unknown` | The signal's `reason` when it is an `Error`, otherwise a new `CanceledException` |
| `_linkSignal(parent)` | `{ controller, dispose }` | A child `AbortController` aborted with the parent; call `dispose()` when done |
| `_backoff({ attempt, baseDelay, type, jitter, maxDelay? })` | `TimeSpan` | The retry delay formula, rounded to whole milliseconds |

Types: `Outcome<T>`, `Executor<T>`, `ResilienceStrategy<T>`, `ShouldHandle<T>`, `ShouldHandlePredicate<T>`, `ResilienceContext`, `BackoffType`, and each strategy's options interface (`RetryStrategyOptions<T>`, `OnRetryArguments<T>`, `TimeoutStrategyOptions`, `FallbackStrategyOptions<T>`, `CircuitBreakerStrategyOptions<T>`, `CircuitState`, `HedgingStrategyOptions<T>`, `ConcurrencyLimiterStrategyOptions`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ResilienceStrategy<T>` | Not registered in DI; lives as long as the pipelines that hold it | The six built-in strategies | Your own function | `builder.addStrategy(myStrategy(options))` |
| A built-in strategy instance | Created by its factory | `retryStrategy(o)` and the others | | Create it once and `addStrategy` it into several pipelines to share its state, eg. one breaker for reads and writes of one dependency |
| Strategy hooks | Options of the built-in strategies | none | | See [Strategy hooks](#strategy-hooks) |
| A shared pipeline | Your choice: a DI value or a singleton service | | | See [Share one pipeline through DI](#share-one-pipeline-through-di) |

### Custom strategy: per-operation metrics and a short-lived result cache

`metricsStrategy` measures every call of the inner chain and tags it with `OperationKey`. `cacheStrategy` keeps successful results per cache key from `Properties` and skips the inner chain on a hit. Both keep their state in the factory closure.

```ts sample
import { Executor, ResilienceStrategy, ResiliencePipelineBuilder, TimeSpan, TimeSpanLike, _capture, _toTimeSpan, _unwrap } from '@spinajs/util';

type Metric = { key: string; ms: number; ok: boolean };

function metricsStrategy<T>(sink: (m: Metric) => void): ResilienceStrategy<T> {
  return (next: Executor<T>) => async (ctx) => {
    const start = performance.now();
    const outcome = await _capture(next, ctx);
    sink({ key: ctx.OperationKey ?? 'anonymous', ms: performance.now() - start, ok: outcome.Error === undefined });
    return _unwrap(outcome);
  };
}

function cacheStrategy<T>(ttl: TimeSpanLike): ResilienceStrategy<T> {
  const lifetime = _toTimeSpan(ttl, TimeSpan.fromSeconds(30));
  const cache = new Map<string, { value: T; until: number }>();

  return (next) => async (ctx) => {
    const key = ctx.Properties.get('cacheKey');
    if (typeof key !== 'string') {
      return next(ctx);
    }
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) {
      return hit.value;
    }
    const value = await next(ctx);
    cache.set(key, { value, until: Date.now() + lifetime.totalMilliseconds });
    return value;
  };
}

const metrics: Metric[] = [];

const exchangeRates = new ResiliencePipelineBuilder<number>()
  .addStrategy(metricsStrategy((m) => metrics.push(m)))
  .addStrategy(cacheStrategy('00:01:00'))
  .addRetry({ MaxRetryAttempts: 2, Delay: 100 })
  .addTimeout(2000)
  .build();

async function rate(from: string, to: string): Promise<number> {
  return exchangeRates.execute(
    async (ctx) => {
      const res = await fetch(`https://fx.example.com/${from}/${to}`, { signal: ctx.Signal });
      return Number(await res.text());
    },
    { OperationKey: 'fx.rate', Properties: new Map([['cacheKey', `${from}-${to}`]]) },
  );
}

rate('EUR', 'PLN')
  .then(() => rate('EUR', 'PLN'))
  .then(() => console.log(metrics), console.error);
```

### Custom strategy: cooperative cancellation with your own child signal

A strategy that bounds the inner chain by an external deadline uses `_linkSignal` so aborting it never aborts the caller's signal, and `_abortReason` to reject with a meaningful error.

```ts sample
import { CanceledException, ResilienceStrategy, ResiliencePipelineBuilder, _abortReason, _linkSignal } from '@spinajs/util';

/** Cancels the inner chain when the request's own deadline (in ms since epoch) in Properties passes. */
function deadlineStrategy<T>(): ResilienceStrategy<T> {
  return (next) => async (ctx) => {
    const deadline = ctx.Properties.get('deadline');
    if (typeof deadline !== 'number') {
      return next(ctx);
    }
    const { controller, dispose } = _linkSignal(ctx.Signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CanceledException('deadline already passed');
    }
    const timer = setTimeout(() => controller.abort(new CanceledException('request deadline passed')), remaining);
    try {
      const result = next({ ...ctx, Signal: controller.signal });
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(_abortReason(controller.signal))));
      return await Promise.race([result, aborted]);
    } finally {
      clearTimeout(timer);
      dispose();
    }
  };
}

const report = new ResiliencePipelineBuilder<string>().addStrategy(deadlineStrategy()).addRetry({ MaxRetryAttempts: 5, Delay: 500 }).build();

report
  .execute(async (ctx) => (await fetch('https://reports.example.com/daily', { signal: ctx.Signal })).text(), {
    Properties: new Map([['deadline', Date.now() + 3000]]),
  })
  .then(console.log, console.error);
```

### Share one circuit breaker between pipelines

Create the strategy once and add it to each pipeline; every pipeline then counts failures into the same window.

```ts sample
import { ResiliencePipelineBuilder, circuitBreakerStrategy } from '@spinajs/util';

type Order = { id: string };

const ordersBreaker = circuitBreakerStrategy<Order>({ FailureRatio: 0.5, MinimumThroughput: 10, BreakDuration: '00:00:20' });

const readOrders = new ResiliencePipelineBuilder<Order>().addStrategy(ordersBreaker).addRetry({ MaxRetryAttempts: 3 }).build();
const writeOrders = new ResiliencePipelineBuilder<Order>().addStrategy(ordersBreaker).build(); // no retry: writes are not idempotent

readOrders.execute(async () => ({ id: 'A-1' })).then(console.log);
writeOrders.execute(async () => ({ id: 'A-2' })).then(console.log);
```

## Strategy hooks

Each hook is a function option of a built-in strategy. Hooks are awaited inline; a hook that throws fails the call.

| Hook | Strategy | Called | Returns |
| --- | --- | --- | --- |
| `DelayGenerator({ AttemptNumber, Outcome })` | retry | Before each retry delay is computed | A `TimeSpanLike` to use, or `undefined` for the backoff formula |
| `OnRetry({ AttemptNumber, Outcome, RetryDelay })` | retry | Before each retry delay | nothing |
| `OnTimeout({ Timeout, Context })` | timeout | When the timeout fires, before the rejection | nothing |
| `FallbackAction({ Outcome, Context })` | fallback | When the outcome is handled | The substitute value |
| `OnFallback({ Outcome, Context })` | fallback | Before `FallbackAction` | nothing |
| `ActionGenerator({ AttemptNumber, Context })` | hedging | For each attempt, `AttemptNumber` 0 first | A `() => Promise<T>` run instead of the inner chain |
| `OnOpened({ Outcome?, BreakDuration })`, `OnClosed()`, `OnHalfOpened()` | circuit breaker | On state transitions | nothing |

## Share one pipeline through DI

`@spinajs/util` registers nothing in DI. When several services must share one pipeline (and so one breaker or permit pool), put it into the container yourself. Two ways:

- **As a value**: `DI.register(pipeline).asValue('key')`, read with `DI.get('key')`. A test replaces it with `asValue('key', true)`.
- **Inside a singleton service**: a `@Singleton()` class builds its pipeline in the constructor. Replace the whole service with `DI.register(Other).as(Service)`.

```ts sample
import { DI, Injectable, Singleton } from '@spinajs/di';
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder } from '@spinajs/util';

const PAYMENTS_PIPELINE = 'pipelines.payments';

DI.register(
  new ResiliencePipelineBuilder<string>()
    .addCircuitBreaker({ FailureRatio: 0.3, MinimumThroughput: 20 })
    .addRetry({ MaxRetryAttempts: 2, BackoffType: BackoffType.Exponential, UseJitter: true })
    .addTimeout(3000)
    .build(),
).asValue(PAYMENTS_PIPELINE);

@Singleton()
@Injectable()
class PaymentGateway {
  protected readonly pipeline = DI.get<ResiliencePipeline<string>>(PAYMENTS_PIPELINE)!;

  public charge(orderId: string, cents: number): Promise<string> {
    return this.pipeline.execute(async (ctx) => {
      const res = await fetch('https://pay.example.com/charges', { method: 'POST', body: JSON.stringify({ orderId, cents }), signal: ctx.Signal });
      return res.text();
    });
  }
}

// in tests: a pipeline with no retries and no breaker
DI.register(new ResiliencePipelineBuilder<string>().build()).asValue(PAYMENTS_PIPELINE, true);

const gateway = DI.resolve(PaymentGateway);
gateway.charge('A-1', 1999).then(console.log, console.error);
```

## Important behaviour

- A strategy factory called once and added to two pipelines shares its closure state; called twice, it creates two independent states.
- `_delay` with a signal that is already aborted rejects at once; with no signal it cannot be cancelled.
- `_linkSignal` adds a listener to the parent signal; skip `dispose()` and a long-lived parent signal keeps every child controller alive.
- `_capture` turns a thrown `undefined` into `{ Error: undefined }`: predicates read it as a success and `_unwrap` returns `undefined`, so `throw undefined` resolves through every built-in strategy.
- Returning without calling `next` short-circuits every inner strategy, including timeouts and retries.

## Best practices

- Use `_capture` and `_unwrap` when the strategy inspects an outcome but passes it on unchanged.
- Read options with `_resolveShouldHandle` and `_toTimeSpan`, so your strategy accepts the same `ShouldHandle` and `TimeSpanLike` forms as the built-ins.
- Pass a new context object to `next` instead of mutating `ctx`; outer strategies and parallel hedged attempts share the original.

## Related

- [Resilience pipeline](07-resilience-pipeline.md): the built-in strategies and their options.
- [`@spinajs/di`](../di/README.md): [values](../di/09-values-and-value-maps.md) and [lifetimes](../di/04-lifetimes.md) for sharing a pipeline.
