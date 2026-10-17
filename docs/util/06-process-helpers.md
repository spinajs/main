# Process helpers

Process-level helpers: promise-based waiting, graceful shutdown handlers, and typed readers for environment variables.

## How it works

### Waiting

| Function | Behaviour |
| --- | --- |
| `sleep(ts)` | Resolves after `ts`, any [`TimeSpanLike`](05-timespan.md). A negative or empty span resolves on the next timer tick |
| `nextTick()` | Resolves on the next event loop turn (`setImmediate`, or `setTimeout(0)` where it is missing). Use it to break up long synchronous loops |
| `withTimeout(promise, ts, error?)` | Settles like `promise`, or rejects with `error` (default `Error('Operation timed out after <ms>ms')`) when `ts` passes first. The operation keeps running |

### Graceful shutdown

1. `onShutdown(handler, { name? })` adds a handler and returns a function that removes it.
2. The first `onShutdown` call attaches `process.once` listeners for `SIGINT` and `SIGTERM`. Importing the module attaches nothing.
3. On a signal the listener calls `runShutdown()`, then `process.exit(0)`.
4. `runShutdown(onError?)` runs the handlers registered at that moment in reverse order (last registered first), awaiting each one.
5. A handler that throws or rejects is reported to `onError(err, name)` (default `console.error`) and the next handler still runs.
6. `runShutdown` runs once: every later call returns the same promise.
7. `clearShutdownHandlers()` removes all handlers, detaches the signal listeners and allows `runShutdown` to run again.

### Environment variables

| Function | Unset | Set |
| --- | --- | --- |
| `envString(name, default?)` | `default` or `undefined` | The raw value, `''` included |
| `envRequired(name)` | Throws `InvalidArgument` (`ENV_MISSING`) | The value; `''` throws `ENV_MISSING` too |
| `envInt(name, default?)` | `default` or `undefined` | `Number(raw)` when it is an integer, otherwise `InvalidArgument` (`ENV_TYPE_MISMATCH`) |
| `envBool(name, default?)` | `default` or `undefined` | `true` for `true`, `1`, `yes`, `on`; `false` for `false`, `0`, `no`, `off`, `''` (trimmed, case-insensitive); anything else throws `InvalidArgument` (`ENV_TYPE_MISMATCH`) |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Shutdown handler, `ShutdownHandler = () => void \| Promise<void>` | Not registered in DI; a module-level registry for the whole process | none | Any teardown function | `onShutdown(handler, { name })`; keep the returned function to remove it |
| Shutdown error reporter, `(err, name) => void` | Argument of `runShutdown` | `console.error` | Your logger | Call `runShutdown(reporter)` yourself before a signal arrives, eg. from your host's stop hook |
| Signal handling | Module state | `process.once('SIGINT' \| 'SIGTERM')` then `process.exit(0)` | Your own host lifecycle | Call `clearShutdownHandlers()` after registering to drop the signal listeners, then call `runShutdown()` from your own stop logic |

### Shutdown handler: tear down the DI container and flush a queue

Register the handlers in the order you acquire the resources; they run in reverse. Pass a reporter to `runShutdown` when you trigger it yourself, so failures reach your logger.

```ts sample
import { DI } from '@spinajs/di';
import { onShutdown, runShutdown, sleep } from '@spinajs/util';

const pending: string[] = ['order-1', 'order-2'];

onShutdown(() => DI.dispose(), { name: 'di-container' });

const removeFlush = onShutdown(
  async () => {
    while (pending.length > 0) {
      console.log('flushing', pending.shift());
      await sleep(10);
    }
  },
  { name: 'order-queue' },
);

async function stopFromHealthCheck(): Promise<void> {
  // runs 'order-queue', then 'di-container'
  await runShutdown((err, name) => console.error(`shutdown step ${name} failed`, err));
}

stopFromHealthCheck().then(() => removeFlush(), console.error);
```

## Important behaviour

- A signal always ends with `process.exit(0)`, even when a handler failed.
- The signal listeners use `process.once`: a second `SIGINT` while handlers run is not caught and Node.js ends the process at once.
- Handlers added after `runShutdown` started are not run; call `clearShutdownHandlers()` first to run again.
- A handler with no `name` uses `handler.name`. An inline arrow function has the name `''`, so its errors are reported with an empty name, not `anonymous`. Pass `{ name }`.
- `withTimeout` does not cancel anything. For cancellation pass an `AbortSignal` to the operation, or use the [timeout strategy](07-resilience-pipeline.md#timeout).
- `envInt` uses `Number()`: `'0x10'` is `16`, `'1e3'` is `1000`, and an empty string is `0`.
- `sleep('abc')` throws synchronously: the string is parsed before the promise is created.

## Best practices

- Read environment variables once at startup into a typed object; `envRequired` then fails fast before the app serves traffic.
- Give every shutdown handler a `name`; the reporter only has the name to tell you which one failed.
- In tests call `clearShutdownHandlers()` in `afterEach`, so handlers and signal listeners do not leak between tests.

## Examples

### Read typed configuration from the environment

```ts sample
import { envBool, envInt, envRequired, envString } from '@spinajs/util';

process.env.DATABASE_URL ??= 'postgres://localhost/app';

const config = {
  port: envInt('PORT', 8080)!,
  debug: envBool('DEBUG', false)!,
  databaseUrl: envRequired('DATABASE_URL'),
  region: envString('AWS_REGION', 'eu-central-1')!,
};

console.log(config);
```

### Keep the event loop responsive during a long loop

```ts sample
import { nextTick, withTimeout } from '@spinajs/util';

async function checksum(rows: string[]): Promise<number> {
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    for (const ch of rows[i]) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
    if (i % 1000 === 0) await nextTick();
  }
  return sum;
}

const rows = Array.from({ length: 10_000 }, (_, i) => `row-${i}`);
withTimeout(checksum(rows), '00:00:05', new Error('checksum took longer than 5 s')).then(console.log, console.error);
```

## Related

- [TimeSpan](05-timespan.md): the `TimeSpanLike` accepted by `sleep` and `withTimeout`.
- [Resilience pipeline](07-resilience-pipeline.md): a timeout that also aborts the operation.
- [`@spinajs/di`](../di/README.md): `DI.dispose()` releases the container's services.
