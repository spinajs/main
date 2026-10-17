# Log levels

The level enum, its name maps, the OpenTelemetry severity mapping, and the runtime level override on every `Log`. In the browser the override survives a page reload through `localStorage` or a cookie.

## How it works

1. **Floor.** The `Log` implementation sets `MinLevel`: in `FrameworkLogger`, the lowest `level` of the rules that match the logger.
2. **Override.** `setLevel()`, `enableAll()` and `disableAll()` set `LevelOverride`. `getLevel()` returns `LevelOverride ?? MinLevel`.
3. **Gate.** Each level method calls `isEnabled(level)`, which is `level >= getLevel()`. A call below it returns before any entry is built.
4. **Persist.** `setLevel(level, persist = true)` calls `persistLevel(Name, level)`. In a browser that writes `localStorage['spinajs:log:level:<Name>']`, or a cookie when storage throws. In Node it does nothing.
5. **Restore.** `FrameworkLogger.resolve()` calls `readPersistedLevel(Name)` and, when a value is stored, uses it as `LevelOverride`.

## API

### Levels

| `LogLevel` | Value | Name (`LogLevelStrings`) | OTel `SeverityNumber` (`LogLevelToSeverityNumber`) |
| --- | --- | --- | --- |
| `Trace` | `0` | `trace` | `1` |
| `Debug` | `1` | `debug` | `5` |
| `Info` | `2` | `info` | `9` |
| `Success` | `3` | `success` | `11` |
| `Warn` | `4` | `warn` | `13` |
| `Error` | `5` | `error` | `17` |
| `Fatal` | `6` | `fatal` | `21` |
| `Security` | `999` | `security` | `23` |

| Export | Meaning |
| --- | --- |
| `StrToLogLevel` | Name to `LogLevel`, eg. `StrToLogLevel.warn === LogLevel.Warn`. |
| `LogLevelStrings` | `LogLevel` to lower-case name. |
| `LogLevelToSeverityNumber` | `LogLevel` to OpenTelemetry `SeverityNumber` (1 to 24). `Success` sits in the INFO band, `Security` at the top of the FATAL band. |
| `SILENT_LEVEL` | `LogLevel.Security + 1` (`1000`). `disableAll()` sets it, so even `security()` is gated out. |
| `normalizeLevel(level)` | Returns a number as it is; maps a name through `StrToLogLevel`; throws `Error('Invalid log level: <name>')` for an unknown name. |

### Runtime level control

| Method | Effect | Persists |
| --- | --- | --- |
| `getLevel()` | `LevelOverride ?? MinLevel` | n/a |
| `setLevel(level, persist = true)` | Sets the override. Takes a `LogLevel` or a name. | When `persist` is `true` |
| `setDefaultLevel(level)` | Sets the override only when none is set. A persisted choice therefore wins over a code default. | Never |
| `resetLevel()` | Clears the override (back to `MinLevel`) and the persisted value. | Clears it |
| `enableAll(persist = true)` | `setLevel(LogLevel.Trace, persist)` | When `persist` is `true` |
| `disableAll(persist = true)` | `setLevel(SILENT_LEVEL, persist)` | When `persist` is `true` |

### Persistence helpers

| Function | Effect in a browser | In Node |
| --- | --- | --- |
| `persistLevel(loggerName, level)` | Writes `String(level)` to `localStorage` under `spinajs:log:level:<loggerName>`. When `localStorage` throws, writes a cookie with the same key, `path=/`, `max-age` one year. | No-op |
| `readPersistedLevel(loggerName)` | Reads `localStorage`, then the cookie. Returns a finite number or `undefined`. | `undefined` |
| `clearPersistedLevel(loggerName)` | Removes the `localStorage` key and expires the cookie. | No-op |

A browser is detected by `typeof window !== 'undefined'`.

## Important behaviour

- The override only gates calls. In `FrameworkLogger`, targets still accept only the levels their rules route. `setLevel('trace')` on a logger whose rules start at `info` lets trace calls build entries that no target takes.
- `setLevel()` persists by default. In a browser, a level set from a debug panel stays until `resetLevel()` or until storage is cleared. Pass `persist = false` for a temporary change.
- Persistence is per logger name. `child('x')` creates logger `<parent>.x`, which has its own key and no override.
- `readPersistedLevel()` accepts any finite number, including `SILENT_LEVEL`. It does not check that the number is a `LogLevel`.
- `createLogMessageObject()` looks the level up in `LogLevelStrings`. Writing an entry at `SILENT_LEVEL` or any other unmapped number throws a `TypeError`.
- `Security` is `999`, far above `Fatal`. A rule with `level: 'fatal'` also routes security entries, unless it sets `maxLevel: 'fatal'`.

## Best practices

- Map levels for external systems with `LogLevelToSeverityNumber`, not with the enum values: the enum is not contiguous (`Security` is `999`).
- Validate level names from user input or query strings with `normalizeLevel()`; it throws one clear error for a typo.
- Use `setDefaultLevel()` for an app default in browser code, so a user's persisted choice is kept.

## Examples

### Turn on debug logs for one module from a browser console

```ts sample
import { DI } from '@spinajs/di';
import { Log, normalizeLevel } from '@spinajs/log-common';

declare global {
  interface Window {
    setLogLevel(logger: string, level: string): void;
  }
}

window.setLogLevel = (logger: string, level: string) => {
  const log = DI.resolve(Log, [logger]);
  log.setLevel(normalizeLevel(level)); // persisted: survives a reload
};

// In devtools: setLogLevel('orm.query', 'debug')
```

### Map an entry to an OpenTelemetry log record

```ts sample
import { createLogMessageObject, ILogEntry, LogLevel, LogLevelToSeverityNumber } from '@spinajs/log-common';

function toOtelRecord(entry: ILogEntry) {
  return {
    severityNumber: LogLevelToSeverityNumber[entry.Level],
    severityText: entry.Variables.level,
    body: entry.Variables.message,
    attributes: { 'logger.name': entry.Variables.logger },
  };
}

const record = toOtelRecord(createLogMessageObject('Disk at %d%%', '', LogLevel.Warn, 'host.monitor', {}, 91));
console.log(record.severityNumber, record.body); // 13 'Disk at 91%'
```

## Related

- [Logger contract](01-logger-contract.md): where `getLevel()` and `isEnabled()` live.
- [Log filters](07-log-filters.md): per-logger and per-target filtering beyond a single floor.
- [`@spinajs/log`](../log/README.md): rule `level` and `maxLevel` windows that set `MinLevel`.
