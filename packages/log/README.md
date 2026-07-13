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
| `FileTarget` | `FileTarget` | a log file via `@spinajs/fs`, with buffering, pluggable rotation + retention and optional zip compression |
| `BlackHoleTarget` | `BlackHoleTarget` | nowhere ( discards; useful in tests ) |
| `GraphanaLogTarget` | `GraphanaLokiLogTarget` (`@spinajs/log-source-graphana-loki`) | Grafana Loki over HTTP, batched with a capped retry buffer |

Common options ( `ICommonTargetOptions` ): `name`, `type`, `enabled`
( default `true` ), `layout` ( default shown in `@spinajs/log-common` ).

### FileTarget & archiving

`FileTarget` writes through the [`@spinajs/fs`](../fs) abstraction, so the active
log ( and its archives ) can live on any registered fs provider — local disk,
S3, FTP, etc. Its nested `options`:

| option | default | meaning |
| --- | --- | --- |
| `path` | *required* | active log path, relative to the `fs` provider base path ( variables allowed, e.g. `log_${logger}.txt` ) |
| `archivePath` | log dir | archive directory, relative to the `archiveFs` provider |
| `fs` | `fs-log-default` | provider for the active log. `fs-log-default` is registered automatically ( base path = `process.cwd()` ) so no fs config is required |
| `archiveFs` | = `fs` | provider archives are moved to |
| `archiveStrategy` | `SizeLogArchiveStrategy` | class name of the rotation strategy ( see below ) |
| `retentionStrategies` | `["CountLogRetentionStrategy"]` | ordered list of retention strategy class names |
| `maxSize` | `1048576` | rotate when the active log exceeds this many bytes ( `SizeLogArchiveStrategy` ) |
| `archiveInterval` | `60` | seconds between size checks ( `SizeLogArchiveStrategy` ) |
| `rotate` | — | cron expression for `CronLogArchiveStrategy` ( 6-field, seconds supported ) |
| `compress` | `false` | zip the archived file, then delete the raw copy |
| `maxBufferSize` | `100` | buffered messages before a flush |
| `maxArchiveFiles` | `5` | archives to keep ( `CountLogRetentionStrategy` ) |
| `maxAge` | `604800` | max archive age in seconds ( `AgeLogRetentionStrategy` ) |

Writes are buffered in memory and flushed as a single batched `fs.append`, either
when the buffer reaches `maxBufferSize` or on a 1s tick. A promise-chain write-lock
serialises flushes and rotations, so a rename never races an in-flight append; on
an append failure the batch is prepended back and retried — nothing is dropped.

**Rotation** ( when to archive ) is a single strategy resolved by class name:

- `SizeLogArchiveStrategy` — interval timer; rotates when the active log passes `maxSize`.
- `CronLogArchiveStrategy` — rotates on the `rotate` cron expression ( required ).

**Retention** ( which archives to delete ) is a LIST applied in order after each
rotation, so policies compose:

- `CountLogRetentionStrategy` — keep the newest `maxArchiveFiles`, delete the oldest.
- `AgeLogRetentionStrategy` — delete archives older than `maxAge` seconds.

Both strategy axes mirror the fs `TempCleanupStrategy` shape and are registered
`@NewInstance()` so each file target owns its own scheduling state. Custom
strategies can be added by extending `LogArchiveStrategy` / `LogRetentionStrategy`
and registering them, then naming the class in the config. The browser entry
( `@spinajs/log/browser` ) omits `FileTarget` and the archive module entirely, so
it never pulls in `@spinajs/fs`.

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
          // relative to the fs provider ( fs-log-default -> process.cwd() )
          path: "logs/log_${logger}_${date:dd_MM_yyyy}.txt",
          archivePath: "logs/archive",
          maxSize: 1024 * 1024,    // 1 MB, then rotate to archive
          compress: true,           // zip archived files
          maxBufferSize: 8 * 1024,  // buffered messages before a disk write
          // rotation + retention ( defaults shown )
          archiveStrategy: "SizeLogArchiveStrategy",
          retentionStrategies: ["CountLogRetentionStrategy", "AgeLogRetentionStrategy"],
          maxArchiveFiles: 5,       // keep 5 newest archives
          maxAge: 7 * 24 * 60 * 60, // and drop anything older than 7 days
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
