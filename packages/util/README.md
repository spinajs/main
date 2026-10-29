# @spinajs/util

Utility functions shared across the `@spinajs` framework — argument validation, functional/async combinators, a `TimeSpan` duration type, a Polly-style resilience pipeline, and an assortment of small helpers.

```ts
import { TimeSpan, ResiliencePipelineBuilder, _check_arg, sleep } from '@spinajs/util';
```

Everything is re-exported from the package root; import by name.

## Documentation

The full, current documentation is in [`docs/util`](../../docs/util/README.md). Where the older pages in `documentation/` disagree with it, `docs/util` is correct.

| Scope | Docs | What's inside |
|---|---|---|
| **Args validation** | [Argument validation](../../docs/util/01-argument-validation.md), [custom checks](../../docs/util/02-custom-argument-checks.md) | `_check_arg`, the built-in checks, writing your own |
| **Assertions** | [Assertions](../../docs/util/03-assertions.md) | type-narrowing runtime asserts |
| **FP / async** | [Async combinators](../../docs/util/04-async-combinators.md) | `_chain`, `_pipe`, `_zip`, `_map`, `_concurrent`, branching and error combinators |
| **TimeSpan** | [TimeSpan](../../docs/util/05-timespan.md) | immutable duration type: construction, parsing, arithmetic, comparison, Date/Luxon interop, formatting |
| **Process** | [Process helpers](../../docs/util/06-process-helpers.md) | `sleep`/`withTimeout`, graceful shutdown, typed env parsing |
| **Resilience** | [Resilience pipeline](../../docs/util/07-resilience-pipeline.md), [custom strategies](../../docs/util/08-custom-resilience-strategies.md) | retry, timeout, circuit breaker, fallback, hedging, concurrency limiter; `PredicateBuilder`; cancellation; writing and sharing strategies |
| **Per-key backoff** | [Keyed backoff](../../docs/util/09-keyed-backoff.md), [Throttle](../../docs/util/10-throttle.md), [custom throttle stores](../../docs/util/11-custom-throttle-stores.md) | `KeyedBackoff`, `Throttle`, `MemoryThrottleStore`, the `ThrottleStore` contract |
| **Core helpers** | [Collections, objects and JSON](../../docs/util/12-collections-objects-and-json.md), [strings, functions and type guards](../../docs/util/13-strings-functions-and-type-guards.md) | `array`, `hash`, `object`, `json`, `string`, `func`, `types` |

## Highlights

**Resilience** — compose strategies into a reusable pipeline:

```ts
const pipeline = new ResiliencePipelineBuilder<Buffer>()
  .addTimeout(TimeSpan.fromSeconds(10))
  .addRetry({ MaxRetryAttempts: 3, BackoffType: BackoffType.Exponential, UseJitter: true })
  .build();

const data = await pipeline.execute(() => downloadAsync());
```

**TimeSpan** — an immutable duration accepted anywhere a `TimeSpanLike` is expected:

```ts
TimeSpan.fromHours(2).add(TimeSpan.fromMinutes(30)).toString(); // '02:30:00'
TimeSpan.parse('1.02:30:45')?.totalHours;                        // 26.5125
```

**Args** — validate and normalize inputs at a boundary:

```ts
const email = _check_arg(_is_string(), _trim(), _to_lower(), _is_email())(input, 'email');
```

## Development

```bash
npm run build    # compile (tsc) to lib
npm test         # run the mocha/ts-node test suite
```

> Coverage note: `npm run coverage` runs `nyc`, but the repo does not currently configure istanbul instrumentation for the ESM + ts-node test setup, so it reports 0%. The suite itself covers every source module; wiring up `@istanbuljs/nyc-config-typescript` would restore real numbers.

## License

MIT
