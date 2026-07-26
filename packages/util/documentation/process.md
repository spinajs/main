# Process utilities (`process`)

Process-level helpers: async timing, graceful shutdown, and typed environment-variable parsing.

```ts
import { sleep, nextTick, withTimeout, onShutdown, runShutdown, envInt, envBool, envRequired } from '@spinajs/util';
```

## Async / timing

### `sleep(ts)`

Promise-based `setTimeout`. Accepts any [`TimeSpanLike`](./timespan.md#the-timespanlike-union):

```ts
await sleep(250);                      // 250 ms
await sleep(TimeSpan.fromSeconds(2));  // 2 s
await sleep('00:00:01.500');           // 1.5 s
```

### `nextTick()`

Yields to the event loop so pending I/O and timers can run. Use it to break up long synchronous loops:

```ts
for (let i = 0; i < huge.length; i++) {
  process(huge[i]);
  if (i % 1000 === 0) await nextTick(); // keep the event loop responsive
}
```

### `withTimeout(promise, ts, error?)`

Races a promise against a deadline. On timeout it rejects (with `error` if given); it does **not** cancel the underlying work — for cancellable timeouts use the [resilience timeout strategy](./resilience.md#timeout--addtimeoutoptions--timespanlike).

```ts
const data = await withTimeout(fetchData(), TimeSpan.fromSeconds(5));

await withTimeout(slow(), 1000, new MyTimeout('too slow')); // custom rejection
```

## Graceful shutdown

Register teardown callbacks that run on `SIGINT` / `SIGTERM` (or a manual trigger). Handlers run **LIFO** — last registered tears down first — mirroring nested resource acquisition. Signal listeners attach lazily on the first `onShutdown` call, so importing the module has no side effects.

```ts
const server = await startServer();
onShutdown(async () => { await server.close(); }, { name: 'http' });

const db = await connect();
onShutdown(async () => { await db.disconnect(); }, { name: 'db' }); // runs before 'http'
```

- Each handler is awaited; a throwing handler is **isolated** (reported, never aborts the rest).
- Shutdown runs **once** — repeated triggers return the same promise.

```ts
onShutdown(() => flushMetrics());

// unregister when a resource is disposed early
const off = onShutdown(() => cache.close());
off();

// trigger manually (e.g. from a health check or test); optional error reporter
await runShutdown((err, name) => log.error(`handler ${name} failed`, err));

// tests / custom lifecycles: reset the registry and detach signal listeners
clearShutdownHandlers();
```

## Environment variables

Typed, validated readers over `process.env`. Missing values fall back to the default (or `undefined`); malformed values throw `InvalidArgument`.

```ts
envString('LOG_LEVEL', 'info');   // string | undefined
envRequired('DATABASE_URL');      // string — throws if unset/empty
envInt('PORT', 3000);             // number | undefined — throws if set but not an integer
envBool('FEATURE_X', false);      // boolean | undefined
```

`envBool` accepts (case-insensitive) `true/1/yes/on` → `true` and `false/0/no/off`/empty → `false`; anything else throws.

```ts
const config = {
  port: envInt('PORT', 8080)!,
  debug: envBool('DEBUG', false)!,
  dbUrl: envRequired('DATABASE_URL'),   // fail fast at startup if missing
  region: envString('AWS_REGION', 'eu-central-1')!,
};
```
