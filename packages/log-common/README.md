# `@spinajs/log-common`

Shared, dependency-light contracts for the SpinaJS logging stack. This package
holds no logging implementation of its own; it defines the abstract types that
`@spinajs/log`, `@spinajs/internal-logger` and the various log-source packages
implement. Depend on it when you write a **custom log target** or a **custom
`Log` implementation**, and want to avoid a circular dependency on `@spinajs/log`.

## What lives here

| Export | Purpose |
| --- | --- |
| `Log` (abstract) | The logger contract: `trace/debug/info/warn/error/fatal/security/success`, `child`, `write`, `addVariable`, `timeStart/timeEnd`. |
| `LogTarget<T>` (abstract) | A sink that receives `ILogEntry` objects and writes them somewhere ( console, file, HTTP, ... ). |
| `createLogMessageObject` | Builds a normalized `ILogEntry` from the many call shapes the `Log` methods accept. |
| `LogLevel` / `StrToLogLevel` / `LogLevelStrings` | Level enum and string<->enum maps. |
| `ILogEntry`, `ILogRule`, `ICommonTargetOptions`, `IFileTargetOptions`, `ILogOptions` | Config and payload shapes. |

## The `LogTarget` contract

```ts
abstract class LogTarget<T extends ICommonTargetOptions> extends SyncService {
  public HasError: boolean;              // true after a failed write, cleared on the next success
  public Error: Error | null | unknown;  // the last write error, or null
  public Options: T;                     // merged options ( includes the default layout )
  public abstract write(data: ILogEntry): void;
}
```

A target receives fully-formed `ILogEntry` objects. It is responsible for:

- honouring `Options.enabled` ( skip when `false` ),
- rendering `data.Variables` through its `Options.layout`,
- setting `HasError = true` / `Error = err` when a write fails and clearing them
  ( `HasError = false`, `Error = null` ) on the next successful write. Consumers
  can poll these fields to detect a degraded sink.

## `createLogMessageObject`

```ts
createLogMessageObject(
  err: Error | string,
  message: string | any[],
  level: LogLevel,
  logger: string,
  variables: any,
  ...args: any[]
): ILogEntry
```

It normalizes the two calling conventions the `Log` methods accept:

- **Message overload** — `err` is the format string ( or `undefined` ) and
  `message` carries the format arguments, e.g. `log.info("hello %s", "world")`.
- **Error overload** — `err` is an `Error` and `message` is the human message,
  e.g. `log.error(err, "could not connect")`.

Rules it applies:

- `sMsg = (err instanceof Error || !err) ? message : err` — an `err` string is
  itself the message body, so a bare `log.info("hi")` works.
- `tMsg = args.length ? format(sMsg, ...args) : sMsg` — runs `util.format`-style
  substitution ( see `format.ts`; `%s %d %i %f %j %o %O %%` ) only when there are
  args.
- `Variables.error` is set only for the `Error` overload.
- `Variables.logger = logger ?? message` and `Variables.level` is the upper-cased
  level string.

The returned entry is:

```ts
{
  Level: LogLevel,
  Variables: {
    error,     // Error | undefined
    level,     // "INFO" | "ERROR" | ...
    logger,    // logger name
    message,   // formatted message
    ...variables
  }
}
```

## Layout variables

A target's `layout` is a template string resolved by `@spinajs/configuration`'s
`format(variables, layout)`. Every key on `ILogEntry.Variables` is available as
`${key}`. The always-present variables are:

| Variable | Value |
| --- | --- |
| `${datetime}` | timestamp of the entry |
| `${level}` | upper-cased level, e.g. `INFO` |
| `${message}` | the formatted message |
| `${error}` | the `Error` ( use `${error:message}` for its message ) |
| `${logger}` | the logger name |

Conditional blocks are supported, e.g. `${?error} ... ${/error}` only renders
when `error` is set. Any custom variable you attach via `log.addVariable(name, value)`
or the config `variables` array is also available as `${name}`.

The default layout ( applied to every target unless overridden ) is:

```
${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})
```

## Writing a custom target

```ts
import { Injectable } from "@spinajs/di";
import { format } from "@spinajs/configuration";
import { LogTarget, ILogEntry, ICommonTargetOptions } from "@spinajs/log-common";

@Injectable("MyTarget") // referenced by `type: "MyTarget"` in config
export class MyTarget extends LogTarget<ICommonTargetOptions> {
  public write(data: ILogEntry): void {
    if (!this.Options.enabled) return;
    try {
      // render with the configured layout and send it somewhere
      send(format(data.Variables, this.Options.layout));
      this.HasError = false;
      this.Error = null;
    } catch (err) {
      this.HasError = true;
      this.Error = err;
    }
  }
}
```

See `@spinajs/log` for the concrete targets and the rules/targets configuration.
