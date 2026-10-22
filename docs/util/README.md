# `@spinajs/util`

Utility functions and small building blocks shared across SpinaJS: argument validation, runtime assertions, async combinators, an immutable `TimeSpan`, process helpers, a Polly-style resilience pipeline, per-key backoff and throttling, and helpers for arrays, maps, JSON, strings and functions.

It has **no** dependency on `@spinajs/di` and registers nothing in a container: every class is built with `new` and every option is a constructor argument. You put a shared instance into DI yourself when you want one (see [Sharing a pipeline through DI](08-custom-resilience-strategies.md#share-one-pipeline-through-di)). It does **not** read configuration files either.

## Install

```sh
npm install @spinajs/util
```

`args.ts` and `timespan.ts` import `luxon`. Install it next to the package (`npm install luxon`): `@spinajs/util` does not list it as a dependency.

Everything except the crypto helpers is exported from the package root. Import by name:

```ts
import { TimeSpan, ResiliencePipelineBuilder, _check_arg, sleep } from '@spinajs/util';
```

The crypto helpers need `node:crypto`, so they live in the Node-only subpath `@spinajs/util/crypto`; the root never loads it.

## Features

| Feature | What it does |
| --- | --- |
| [Argument validation](01-argument-validation.md) | `_check_arg` and the `_is_*`, range, choice, pattern and conversion checks that validate and normalize a value |
| [Custom argument checks](02-custom-argument-checks.md) | The check signature, writing your own validating, transforming and type-guarding checks |
| [Assertions](03-assertions.md) | `assert`, `assertNonNil`, `assertString` and other `asserts` guards that narrow a type |
| [Async combinators](04-async-combinators.md) | `_chain`, `_pipe`, `_zip`, `_map`, `_concurrent`, `_batch`, branching and error combinators |
| [TimeSpan](05-timespan.md) | Immutable duration: construction, parsing, `TimeSpanLike`, arithmetic, comparison, Date and Luxon interop |
| [Process helpers](06-process-helpers.md) | `sleep`, `nextTick`, `withTimeout`, graceful shutdown handlers, typed environment variables |
| [Resilience pipeline](07-resilience-pipeline.md) | `ResiliencePipelineBuilder`, strategy order, `ResilienceContext`, cancellation, `PredicateBuilder`, retry, timeout, fallback, circuit breaker, hedging, concurrency limiter |
| [Custom resilience strategies](08-custom-resilience-strategies.md) | `ResilienceStrategy`, `addStrategy`, the low-level primitives, the strategy hooks, sharing a pipeline through DI |
| [Keyed backoff](09-keyed-backoff.md) | `KeyedBackoff`: per-key exponential backoff in memory, eviction, the `delay` and `onFull` hooks, subclassing |
| [Throttle](10-throttle.md) | `Throttle` and `MemoryThrottleStore`: flow rules, gates, counted keys, `onSuccess`, `keyId`, IPv6 prefix keys with `throttleIp` |
| [Custom throttle stores](11-custom-throttle-stores.md) | The `ThrottleStore` contract, writing a shared store, the `MemoryThrottleStore` limiter factory |
| [Collections, objects and JSON](12-collections-objects-and-json.md) | `toArray`, `chunk`, `unique`, `sortedUnique`, `groupBy`, `tryGetHash`, `deepFreeze`, `frozenCopy`, `copyPlainData`, `deepEqual`, `deepMerge`, `getOwnPath`, Map/Set/Date-aware JSON, `stableStringify` |
| [Strings, functions and type guards](13-strings-functions-and-type-guards.md) | `trimChar`, `truncate`, `asciiLower`, `escapeHtml`, `compareCodePoints`, `quote`, `parseIsoInstant`, `toEpochMs`, `thenMaybe`, `allMaybe`, `Lazy`, `once`, `memoize`, `isPromise`, `isThenable`, `isStringArray`, `isDefined` |
| [Async helpers, caches and graphs](14-async-helpers-caches-and-graphs.md) | `onceAsync`, `memoizeAsync`, `singleFlight`, `KeyedMutex`, `TaskTracker`, `settleWithin`, `Deadline`, `RefreshingCache`, `LruTtlCache`, `BoundedMap`, `Clock`, `ListenerSet`, `findCycle`, `reachable` |
| [Crypto helpers](14-crypto.md) | `@spinajs/util/crypto`: `sha256`, `hmacSha256`, `taggedHash`, constant-time comparison, strict base64url/base64/base32, `randomToken`, `processSecret`, `parseKeyMaterial` |

## Quick start

Validate a port from the environment, then call a flaky service with a per-attempt timeout and exponential retries.

```ts sample
import { BackoffType, ResiliencePipelineBuilder, TimeSpan, _between, _check_arg, _is_string, _to_int } from '@spinajs/util';

const port: number = _check_arg(_is_string(), _to_int(), _between(1, 65535))(process.env.PORT ?? '8080', 'PORT');

const pipeline = new ResiliencePipelineBuilder<string>()
  .addRetry({ MaxRetryAttempts: 3, Delay: TimeSpan.fromMilliseconds(200), BackoffType: BackoffType.Exponential, UseJitter: true })
  .addTimeout(TimeSpan.fromSeconds(2))
  .build();

async function checkHealth(): Promise<string> {
  return pipeline.execute(async (ctx) => {
    const res = await fetch(`http://localhost:${port}/health`, { signal: ctx.Signal });
    return res.text();
  });
}

checkHealth().then(console.log, console.error);
```

## Related packages

- [`@spinajs/exceptions`](../exceptions/README.md): `InvalidArgument`, `InvalidOperation` and the `Exception` base every error here extends.
- [`@spinajs/di`](../di/README.md): uses `isPromise` and `uniqueBy`; register a shared util instance there as a value or a singleton.
- [`@spinajs/log`](../log/README.md): `RetryingTarget` wraps a log target in a resilience pipeline.
- [`@spinajs/email-smtp-transport`](../email-smtp-transport/README.md), [`@spinajs/queue-amqp-transport`](../queue-amqp-transport/README.md), [`@spinajs/queue-stomp-transport`](../queue-stomp-transport/README.md), [`@spinajs/log-source-graphana-loki`](../log-source-graphana-loki/README.md): build their retry and timeout around sends with `ResiliencePipelineBuilder`.
- [`@spinajs/authn`](../authn/README.md): builds its login throttles on `KeyedBackoff`, `Throttle` and `MemoryThrottleStore`; `@spinajs/authn-orm` ships `DbThrottleStore`, a SQL `ThrottleStore`.
