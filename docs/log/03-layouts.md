# Layouts

A layout is the line format of a text target (`ConsoleTarget`, `FileTarget`). It is a string with `${...}` placeholders filled from the entry's variables and from the `ConfigVariable`s of [`@spinajs/configuration-common`](../configuration-common/01-templating.md). JSON targets ignore it.

## How it works

1. `LogTarget`'s constructor merges the target definition over `{ enabled: true, layout: <default> }`.
2. On write, the target calls `format(entry.Variables, this.Options.layout)` from `@spinajs/configuration`.
3. `format()` first renders the entry's `message` against the same variables, then the layout.
4. Conditional blocks `${?name} ... ${/name}` are kept only when `name` is a set, non-empty variable.
5. Each `${name}` or `${name:option}` is filled:
   1. from the entry variable `name` when it is truthy: a function is called with `option`; with an `option`, the property `option` of the value is taken (or called when it is a function); otherwise the value is inserted;
   2. else from the `ConfigVariable` whose `Name` is `name`, called with `option`;
   3. else with `''`.

The default layout:

```
${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})
```

## Placeholders

| Placeholder | Source | Renders |
| --- | --- | --- |
| `${message}` | entry | Formatted message. |
| `${level}` | entry | Upper-case level, eg. `ERROR`. |
| `${logger}` | entry | Logger name. |
| `${error:message}`, `${error:stack}`, `${error:code}` | entry | A property of the serialized `error` (`name`, `message`, `stack`, `code`, `signal`). |
| `${?error} ... ${/error}` | entry | Body only when the entry has an error. |
| `${orderId}` | entry | Any field of an object-shape call, a logger variable (`addVariable()`) or an ambient [`LogContext`](12-async-context-and-tracing.md) field. |
| `${callsite}` | entry | Caller's `file:line`, eg. `checkout.ts:42`. See below. |
| `${datetime}`, `${date:yyyy-MM-dd}`, `${time}`, `${utcdatetime}`, `${timestamp:s}` | `ConfigVariable` | Current time; the option is a luxon format. |
| `${env:NAME}`, `${hostname}`, `${pid}`, `${uuid}`, ... | `ConfigVariable` | See the [built-in variables](../configuration-common/02-built-in-variables.md). |

Variable precedence inside an entry, lowest first: ambient `LogContext` fields, core fields (`error`, `level`, `logger`, `message`), logger variables, fields of the call.

## `${callsite}`

- `captureCallsite()` walks a fresh `new Error().stack` and returns the first frame outside the log packages, as `basename:line`.
- It skips frames in `log.ts` / `callsite.ts` (or `.js`), under any `log/` or `log-common/` `src` or `lib` folder, and in `wrapWrite`, `createLogMessageObject`, `captureCallsite`.
- It is captured **only** when at least one target of the logger has `${callsite}` in its layout (`FrameworkLogger.CaptureCallsite`). Other loggers never build the `Error`.
- An unparsable stack gives `''`; capture never throws.

```js
{ name: 'Console', type: 'ConsoleTarget', layout: '${time} ${level} ${message} @ ${callsite} (${logger})' }
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.targets[].layout` | `string` | the default layout above | any placeholder string | Line format of a text target. |
| `logger.targets[].options.path` (file targets) | `string` | required | placeholders allowed | File path; `${logger}` here is the **target name**, see [File target](05-file-target.md). |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Layout variable | `ConfigVariable`, collected with `Array.ofType(ConfigVariable)` on the first `format()` call | `DateTimeLogVariable`, `DateLogVariable`, `TimeLogVariable`, `EnvVariable`, ... | `ElectronPathVariables` in `@spinajs/electron` | Register a class with `@Injectable(ConfigVariable)` before the first log line. Full contract: [Custom variables](../configuration-common/03-custom-variables.md). |
| Per-logger variable | `log.addVariable(name, value)` | none | | A function value is called on every rendered line, with the placeholder option. |
| Line format of file targets | protected `FileTarget.formatEntry()` | renders the layout | `JsonFileTarget` | Subclass, see [Custom targets](08-custom-targets.md#extending-filetarget-change-only-the-line-format). |

### Custom layout variables

Add a `ConfigVariable` when the value is process-wide (a release tag, a node id). Add a logger variable with a function value when it belongs to one logger.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ConfigVariable } from '@spinajs/configuration-common';
import { Log } from '@spinajs/log';

// layout: '${datetime} [${release:short}] ${level} ${message} (${logger}, heap ${heapMb}MB)'
@Injectable(ConfigVariable)
export class ReleaseVariable extends ConfigVariable {
  public get Name(): string {
    return 'release';
  }

  public Value(option?: string): string {
    const version = process.env.APP_VERSION ?? '0.0.0';
    return option === 'short' ? version : `${version}+${process.env.GIT_COMMIT ?? 'local'}`;
  }
}

export function workerLogger(): Log {
  const log = DI.resolve(Log, ['worker']);
  log.addVariable('heapMb', () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
  return log;
}
```

## Important behaviour

- The `ConfigVariable` set is frozen on the first `format()` call in the process. Import modules that register variables before the first log line.
- An entry variable shadows a `ConfigVariable` with the same name: a call field named `user` or `date` replaces `${user}` or `${date}`.
- A falsy entry value (`0`, `false`, `''`) is not inserted: the placeholder falls through to a `ConfigVariable` of that name, else `''`. `${retries}` with `retries: 0` renders empty.
- The `message` is rendered against the variables before the layout, so a printf argument containing `${env:...}` is expanded on text targets. Pass untrusted values as fields; field templates escape `$`. See [Logging API](01-logging-api.md#important-behaviour).
- `${callsite}` in any one target of a logger turns on capture for every call of that logger, for all its targets.

## Best practices

- Use `${utcdatetime}` or `${datetime:yyyy-MM-dd'T'HH:mm:ss.SSSZZ}` when lines from several hosts are merged.
- Keep `${callsite}` in development layouts only; capture builds an `Error` on every call.
- Prefer JSON targets for machine ingestion; layouts are for humans.

## Patterns and antipatterns

```js
// Don't: a production JSON pipeline that parses text lines with regexes
{ name: 'Out', type: 'ConsoleTarget', layout: '${datetime}|${level}|${logger}|${message}' }

// Do: emit NDJSON and let the collector index fields
{ name: 'Out', type: 'JsonTarget' }
```

## Examples

### Show the request id on every console line

```js
// config/logger.js; requestId comes from the @spinajs/http request context
module.exports = {
  logger: {
    targets: [
      {
        name: 'Console',
        type: 'ConsoleTarget',
        layout: '${time} ${level} ${?requestId}[${requestId}] ${/requestId}${message}${?error}: ${error:message}${/error} (${logger})',
      },
    ],
    rules: [{ name: '*', level: 'info', target: 'Console' }],
  },
};
```

## Related

- [`@spinajs/configuration-common` templating](../configuration-common/01-templating.md): the `format()` engine.
- [Async context and tracing](12-async-context-and-tracing.md): ambient fields that layouts can print.
- [Structured logging and serializers](11-structured-logging-and-serializers.md): the `error` fields behind `${error:...}`.
