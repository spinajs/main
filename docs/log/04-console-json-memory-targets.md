# Console, JSON and memory targets

Four unbuffered targets that write on every entry: `ConsoleTarget` for humans, `JsonTarget` for log collectors reading stdout, `MemoryTarget` for reading recent entries back in-process, and `BlackHoleTarget` for discarding.

## How it works

1. A rule routes an entry to the target; `FrameworkLogger.write()` calls `target.write(entry)`.
2. Each target returns at once when its `enabled` option is `false`.
3. The target renders and emits the entry:
   - `ColoredConsoleTarget` (`type: 'ConsoleTarget'`): `format(entry.Variables, layout)`, wrapped in an ANSI color per level, sent to `console.debug` / `console.log` / `console.warn` / `console.error` (see the [level table](01-logging-api.md#levels));
   - `JsonTarget`: one JSON object per line, `{ time, severityNumber, ...entry.Variables }`, written with `process.stdout.write` (or `stderr`); without `process`, `console.log`;
   - `MemoryTarget`: pushes the `ILogEntry` into an array and drops the oldest past `limit`;
   - `BlackHoleTarget`: nothing.

## Configuration

All four read their options **flat** on the target definition.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.targets[].layout` (`ConsoleTarget`) | `string` | default layout | see [Layouts](03-layouts.md) | Line format. |
| `logger.targets[].theme` (`ConsoleTarget`) | `object` keyed by level | `DEFAULT_THEME` | per level: a style name or an array of names (`red`, `brightRed`, `bgRed`, `bgBrightRed`, ... for the eight ANSI colors, `gray`, `bgGray`, `bold`, `dim`, `italic`, `underline`, `inverse`) | Per-level colors, merged over `DEFAULT_THEME`. Unknown names are ignored. |
| `logger.targets[].stream` (`JsonTarget`) | `string` | `'stdout'` | `'stdout'`, `'stderr'` | Output stream. |
| `logger.targets[].limit` (`MemoryTarget`) | `number` | `100` | `>= 1` | Entries kept; the oldest are dropped first. |
| `logger.targets[].enabled` | `boolean` | `true` | | `false`: never constructed by config routing. |

`ConsoleTarget` default colors (`DEFAULT_THEME`): `trace` and `debug` gray, `info` white, `success` white on green, `warn` yellow, `error` red, `fatal` white on red, `security` yellow on red.

A `JsonTarget` line:

```json
{"time":"2026-10-17T09:12:44.120Z","severityNumber":17,"error":{"name":"Error","message":"connect ECONNREFUSED","stack":"Error: connect ECONNREFUSED ...","code":"ECONNREFUSED"},"level":"ERROR","logger":"orders","message":"cannot reach payment gateway","requestId":"5f0c...","orderId":1042}
```

```js
targets: [
  { name: 'Console', type: 'ConsoleTarget', layout: '${time} ${level} ${message} (${logger})' },
  { name: 'Json', type: 'JsonTarget', stream: 'stdout' },
  { name: 'Recent', type: 'MemoryTarget', limit: 200 },
  { name: 'Null', type: 'BlackHoleTarget' },
]
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Console output | `'ConsoleTarget'`, `@Singleton()` | `ColoredConsoleTarget` (Node entry) | `BrowserConsoleTarget` (browser entry, same name) | Register your class with `@Injectable('ConsoleTarget')` after `@spinajs/log` is imported; the last registration under the name wins. Or subclass `ColoredConsoleTarget` and override `write()`. |
| NDJSON to a stream | `'JsonTarget'`, `@Singleton()` | `JsonTarget` | `JsonFileTarget` (to a file) | Subclass and override `write()`, eg. to rename fields. |
| In-memory ring | `'MemoryTarget'`, `@Singleton()` | `MemoryTarget` | none | Subclass to keep only some entries or to expose a query API. |
| Discard | `'BlackHoleTarget'`, `@Singleton()` | `BlackHoleTarget` | none | |

`MemoryTarget` API: `getRecords()` returns a copy of the kept entries, oldest first; `clear()` empties it.

### Replacing the console target: one-line JSON in production, colors in development

The console definition stays the same in every environment; the class behind `'ConsoleTarget'` changes.

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { ColoredConsoleTarget, ILogEntry, LogLevelToSeverityNumber, safeStringify } from '@spinajs/log';

@Singleton()
@Injectable('ConsoleTarget')
export class EnvironmentAwareConsoleTarget extends ColoredConsoleTarget {
  public async write(entry: ILogEntry): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      return super.write(entry);
    }

    if (!this.Options.enabled) {
      return;
    }

    const { level, logger, message, ...fields } = entry.Variables;
    process.stdout.write(safeStringify({ ts: Date.now(), sev: LogLevelToSeverityNumber[entry.Level], level, logger, message, ...fields }) + '\n');
  }
}
```

Import this module after `@spinajs/log` and before the first logger resolves; loggers resolved earlier keep the old instance.

## Important behaviour

- All four are singletons per type. Two definitions with the same `type` share the first definition's instance and options, and a logger routed to both writes each entry twice into it.
- `JsonTarget` stamps `time` when it writes, which is the log time because it does not buffer.
- `JsonTarget` and `MemoryTarget` ignore `layout`.
- In `JsonTarget`, entry variables are spread after `time` and `severityNumber`, so a field with one of those names replaces them.
- `MemoryTarget` keeps entry objects, not copies: a filter that mutates an entry later does not affect what was stored, but your code can mutate the stored entries.
- `ColoredConsoleTarget.write()` never rejects for a write error; console calls are synchronous.
- `BrowserConsoleTarget` and `ColoredConsoleTarget` both register as `'ConsoleTarget'`. The Node entry never imports the browser one; see [Browser build](18-browser-build.md).

## Best practices

- In containers, send `JsonTarget` to `stdout` and let the platform ship it; keep `ConsoleTarget` for local development.
- Resolve a logger routed to `MemoryTarget` before you call `DI.resolve('MemoryTarget')`: the first resolve builds the singleton, and a resolve without the definition gets the default `limit` of `100`.
- Use `BlackHoleTarget` in tests to silence output while keeping rules valid.

## Patterns and antipatterns

```ts
// Don't: resolve the ring before any logger; it is built without its definition and limit 500 is lost
const ring = DI.resolve<MemoryTarget>('MemoryTarget');

// Do: let a routed logger build it from config first
DI.resolve(Log, ['http']);
const ring = DI.resolve<MemoryTarget>('MemoryTarget');
```

## Examples

### Attach the last 50 log lines to a crash report

```ts sample
import { DI } from '@spinajs/di';
import { Log, MemoryTarget } from '@spinajs/log';

// config: targets: [{ name: 'Recent', type: 'MemoryTarget', limit: 50 }], rules: [{ name: '*', level: 'trace', target: 'Recent' }]
export function buildCrashReport(err: Error): { error: string; recent: string[] } {
  DI.resolve(Log, ['crash']);
  const ring = DI.resolve<MemoryTarget>('MemoryTarget');

  const recent = ring.getRecords().map((e) => `${e.Variables.level} ${e.Variables.logger}: ${e.Variables.message}`);
  ring.clear();

  return { error: err.stack ?? err.message, recent };
}
```

## Related

- [Configuration and rules](02-configuration-and-rules.md): target definitions and routing.
- [Custom targets](08-custom-targets.md): writing a target from scratch.
- [Runtime targets and levels](13-runtime-targets-and-levels.md): attach a `MemoryTarget` to one logger at run time.
