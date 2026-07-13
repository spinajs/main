# `@spinajs/log`

The concrete logging implementation for SpinaJS. It provides the `Log` service
you resolve to get a logger, a set of built-in **targets** ( sinks ), and a
**rules + targets** configuration model that decides which logger writes where.

## Quick start

```ts
import { DI } from "@spinajs/di";
import { Log } from "@spinajs/log";

const log = await DI.resolve(Log, ["my-module"]); // logger named "my-module"

log.info("started");
log.info("user %s logged in", userId);
log.error(err, "could not connect to %s", host);
```

Which package do I import?

- **`@spinajs/log`** — application code. Resolve `Log` and log.
- **`@spinajs/log-common`** — only when writing a custom target or `Log`
  implementation ( abstract contracts, no impl, avoids a circular dep ).
- **`@spinajs/internal-logger`** — only inside low-level packages ( e.g.
  configuration/DI ) that must log *before* the logger/config exists. Its
  messages are buffered and replayed into the real logger once configuration
  resolves ( see "Stack overview" below ).

## Targets

A **target** is where messages go. Configure targets under `logger.targets`;
each has a `name` ( referenced by rules ) and a `type` ( the injectable key ).

| `type` | Class | Writes to |
| --- | --- | --- |
| `ConsoleTarget` | `ColoredConsoleTarget` | stdout/stderr with ANSI colours per level ( Node ) |
| `FileTarget` | `FileTarget` | a log file, with buffering, size/interval-based archiving and optional gzip compression |
| `BlackHoleTarget` | `BlackHoleTarget` | nowhere ( discards; useful in tests ) |
| `GraphanaLogTarget` | `GraphanaLokiLogTarget` (`@spinajs/log-source-graphana-loki`) | Grafana Loki over HTTP, batched with a capped retry buffer |

Common options ( `ICommonTargetOptions` ): `name`, `type`, `enabled`
( default `true` ), `layout` ( default shown in `@spinajs/log-common` ).

`FileTarget` adds a nested `options` object: `path`, `archivePath`, `maxSize`,
`compress`, `rotate`, `maxBufferSize`, `maxArchiveFiles`, `archiveInterval`. Both
`path` and `archivePath` may contain variables, e.g. `log_${logger}_${date:dd_MM_yyyy}.txt`.

## Rules

A **rule** ( `logger.rules` ) binds a logger name pattern to a minimum `level`
and one or more `target` names:

```ts
{ name: "http/*/controller", level: "info", target: ["Console", "File"] }
```

`name` matching ( `matchRulesToLogger` ) uses glob semantics:

- `*` — matches any logger name.
- `prefix*` — matches names starting with `prefix` ( e.g. `http*` ).
- `a.b.*` — dotted namespaces.
- an exact name matches only itself.

When both a wildcard rule and a more specific rule match a logger, the **specific
rule wins** and the wildcard is dropped ( all matching specific rules are kept ).

## Configuration example

Drawn from `test/config/logger.js`:

```js
module.exports = {
  logger: {
    variables: [],
    targets: [
      {
        name: "File",
        type: "FileTarget",
        options: {
          path: "./logs/log_${logger}_${date:dd_MM_yyyy}.txt",
          archivePath: "./logs/archive",
          maxSize: 1024 * 1024,   // 1 MB, then rotate to archive
          compress: true,          // gzip archived files
          maxArchiveFiles: 5,      // keep 5 newest archives, delete older
          maxBufferSize: 8 * 1024, // buffered messages before a disk write
        },
      },
      { name: "Console", type: "ConsoleTarget" },
    ],
    rules: [
      { name: "*", level: "trace", target: "Console" },      // everything -> console
      { name: "FileLogger", level: "trace", target: "File" }, // this logger also -> file
    ],
  },
};
```

The config is validated against the schema in
`src/schemas/log.configuration.ts`: `targets` and `rules` are both required
non-empty, unique arrays; a target requires `name` + `type`; a rule requires
`name` + `level` ( one of the eight level strings ) + `target` ( string or array
of strings ).

## Log levels

`trace < debug < info < success < warn < error < fatal < security`. A rule's
`level` is the minimum; lower-severity messages for that logger are dropped.

## Stack overview

```
your code ──> @spinajs/log ( Log service, targets, rules )
                    ▲
 low-level pkgs ──> @spinajs/internal-logger  (buffers until config is ready,
                    │                           then replays into @spinajs/log)
                    ▼
              @spinajs/log-common  (shared contracts: Log, LogTarget,
                                    createLogMessageObject, layout variables)
```

`InternalLogger` exists so packages that load **before** the configuration and
logging systems ( DI, configuration ) can still log. Those messages go into a
static buffer; when `Configuration` resolves, the buffer is flushed into the real
`@spinajs/log` targets. As a last resort, on process `beforeExit` any still-buffered
messages are printed to the console so nothing is silently lost. Do not use
`InternalLogger` in application code — resolve `Log` instead.
