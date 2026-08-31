# @spinajs/util

Utility functions shared across the `@spinajs` framework — argument validation, functional/async combinators, a `TimeSpan` duration type, a Polly-style resilience pipeline, and an assortment of small helpers.

```ts
import { TimeSpan, ResiliencePipelineBuilder, _check_arg, sleep } from '@spinajs/util';
```

Everything is re-exported from the package root; import by name.

## Documentation

| Scope | Docs | What's inside |
|---|---|---|
| **Resilience** | [documentation/resilience.md](./documentation/resilience.md) | retry, timeout, circuit breaker, fallback, hedging, concurrency limiter; pipeline builder; `PredicateBuilder`; cancellation |
| **TimeSpan** | [documentation/timespan.md](./documentation/timespan.md) | immutable duration type: construction, parsing, arithmetic, comparison, Date/Luxon interop, formatting |
| **Args validation** | [documentation/args.md](./documentation/args.md) | `_check_arg` + composable validate/transform checks |
| **FP / async** | [documentation/fp.md](./documentation/fp.md) | `_chain`, `_zip`, `_map`, `_use`, `_tap`, `_either`, error combinators |
| **Process** | [documentation/process.md](./documentation/process.md) | `sleep`/`withTimeout`, graceful shutdown, typed env parsing |
| **Assertions** | [documentation/assert.md](./documentation/assert.md) | type-narrowing runtime asserts |
| **Core helpers** | [documentation/utilities.md](./documentation/utilities.md) | `array`, `hash`, `json`, `string`, `func`, `types` |

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
npm run build    # compile (tsc) to lib/mjs
npm test         # run the mocha/ts-node test suite
```

> Coverage note: `npm run coverage` runs `nyc`, but the repo does not currently configure istanbul instrumentation for the ESM + ts-node test setup, so it reports 0%. The suite itself covers every source module; wiring up `@istanbuljs/nyc-config-typescript` would restore real numbers.

## License

MIT
