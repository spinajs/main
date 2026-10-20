# Browser build

Bundlers that honor the `browser` export condition get `index.browser.js` instead of the Node entry. It keeps the same `Log` API, rules, filters and the platform-free targets, swaps the console target for one without ANSI colors, and drops everything that needs `fs`, `async_hooks` or `process`.

## How it works

1. `import '@spinajs/log'` under the `browser` condition (or `import '@spinajs/log/browser'` explicitly) loads `index.browser.js`.
2. It registers the same `Log` factory and `FrameworkLogger` as the Node entry, the filters, and the browser-safe targets.
3. It imports `@spinajs/configuration`, whose browser entry registers `BrowserFrameworkConfiguration`; one side-effect import wires logging and configuration.
4. At import it calls `setLogContextProvider(() => scalarContext(LogContext.active()))`; there is no bootstrapper in this entry.
5. `FrameworkLogger.resolve()` reads a persisted runtime level for its name from `localStorage` (cookie fallback) into the override.

## What the browser entry contains

| Included | Not included |
| --- | --- |
| `Log`, `FrameworkLogger`, `@Logger`, the factory registrations | `FileTarget`, `JsonFileTarget`, the archive module and strategies |
| `BrowserConsoleTarget` (as `'ConsoleTarget'`), `JsonTarget`, `MemoryTarget`, `BlackHoleTarget` | `ColoredConsoleTarget` |
| `SplitGroupTarget`, `AutoFlushTarget`, `RetryingTarget`, `FallbackGroupTarget` | `LogBotstrapper` and its process handlers |
| `LevelFilter`, `MatchFilter`, `RateLimitFilter`, everything from `@spinajs/log-common` (incl. `WhenRepeatedFilter`, `Perf`, `PerfSink`) | `LogMetricSink`, `@Measure`, `wirePerfScope` |
| `LogContext` (synchronous), `scalarContext`, `traceparent` helpers | `captureCallsite` export (capture still works inside the logger) |

## Configuration

Same `logger` keys as on Node ([Configuration and rules](02-configuration-and-rules.md)). Targets missing from the browser entry fail to resolve; keep browser configs to the targets above.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `localStorage['spinajs:log:level:<logger>']` | `string` (numeric `LogLevel`) | unset | | Persisted override written by `setLevel()` / `enableAll()` / `disableAll()` with `persist = true`. |
| cookie `spinajs:log:level:<logger>` (URI-encoded name) | same | unset | | Fallback when `localStorage` is missing or throws; `path=/`, one year. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Console output | `'ConsoleTarget'`, `@Singleton()` | `BrowserConsoleTarget` | | Register your class as `@Injectable('ConsoleTarget')` after the import, eg. to forward to a remote collector. |
| Context provider | `setLogContextProvider()` | synchronous `LogContext` projection, set at import | | Call `setLogContextProvider()` after the import. |
| Perf sink | `PerfSink` | none in this entry | your own | Register a `PerfSink`, see [Custom perf sinks](16-custom-perf-sinks.md). |

## Important behaviour

- `LogContext` has no async isolation in the browser: `with(vars, fn)` holds the context only during the synchronous part of `fn`. Code after an `await` inside `fn` sees the outer context. Wrap callbacks with `bind()`.
- Browser devtools attribute every line to `BrowserConsoleTarget`, not your call site. Add `${callsite}` to the layout to see the origin.
- A persisted level survives reloads and wins over `setDefaultLevel()`; clear it with `resetLevel()`.
- `JsonTarget` falls back to `console.log` when `process.stdout` is missing.
- `Perf` works, but without `LogMetricSink` and without a scope backend, spans reach only the sinks you register and rollups are empty.
- `BrowserConsoleTarget` is exported only from the browser entry; never import it into Node code, where it would replace `ColoredConsoleTarget` under `'ConsoleTarget'`.

## Best practices

- Give users a way to turn on debug output per logger with `setLevel(..., true)` instead of shipping `trace` rules.
- Keep the browser `logger` config in its own file so Node-only targets never appear in it.

## Patterns and antipatterns

```ts
// Don't: async work inside with() loses the context after the first await in the browser
LogContext.with({ screen: 'checkout' }, async () => {
  await loadCart();
  log.info('cart loaded'); // no `screen` field in the browser
});

// Do: pass per-call fields for async flows
await loadCart();
log.info({ screen: 'checkout' }, 'cart loaded');
```

## Examples

### Turn on debug logs from the address bar

```ts sample
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';

// https://shop.example.com/?debug=checkout,cart  enables debug for those loggers and remembers it
export function applyDebugFromUrl(search: string): void {
  const params = new URLSearchParams(search);
  const names = (params.get('debug') ?? '').split(',').filter(Boolean);

  for (const name of names) {
    DI.resolve(Log, [name]).setLevel('debug', true);
  }

  if (params.has('nodebug')) {
    for (const log of Log.Loggers.values()) {
      log.resetLevel();
    }
  }
}
```

The level only gates calls; the browser `logger.rules` must still route `debug` for those loggers to a target.

## Related

- [Async context and tracing](12-async-context-and-tracing.md): the Node `LogContext` and its guarantees.
- [Runtime targets and levels](13-runtime-targets-and-levels.md): `setLevel()` and persistence.
- [`@spinajs/configuration` browser configuration](../configuration/10-browser-configuration.md): the configuration the browser entry wires.
