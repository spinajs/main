# `@spinajs/log`

The logging system for SpinaJS. You resolve a `Log` service, call level methods
(`info`, `error`, …), and a **rules + targets** configuration decides which
logger writes **where** and in **what format**. It supports plain-text layouts
and structured JSON, buffered file logging with rotation/retention, network
sinks (Grafana Loki, OTLP), composable wrapper targets, a filter pipeline,
ambient request-scoped context with trace correlation, and runtime level
control.

## Table of contents

- [Which package do I import?](#which-package-do-i-import)
- [Quick start](#quick-start)
- [Log levels](#log-levels)
- [Loggers](#loggers)
- [Logging API](#logging-api)
- [Layouts / templates](#layouts--templates)
- [Targets (sinks)](#targets-sinks)
- [Rules](#rules)
- [Filters](#filters)
- [Structured logging](#structured-logging)
- [Async context & correlation](#async-context--correlation)
- [File archiving](#file-archiving)
- [Runtime level control](#runtime-level-control)
- [Configuration reference](#configuration-reference)
- [Extending](#extending)
- [Package map](#package-map)

## Which package do I import?

| Package | Use it for |
| --- | --- |
| `@spinajs/log` | **Application code.** Resolve `Log` and log. Ships the console/file/JSON/memory targets, the filter pipeline, `LogContext`, and runtime level control. |
| `@spinajs/log-common` | Only when writing a **custom target or filter** (abstract `LogTarget` / `LogFilter`, `ILogEntry`, `LogLevel`, `createLogMessageObject`, `serializeError`/`safeStringify`, `BatchQueue`). No implementation, so it avoids a circular dependency. |
| `@spinajs/internal-logger` | Only inside low-level packages (DI, configuration) that must log **before** the logger/config exists. Messages buffer and replay into the real logger once configuration resolves. |
| `@spinajs/log-source-graphana-loki` | The Grafana **Loki** target (`GraphanaLogTarget`). |
| `@spinajs/log-otlp` | The **OTLP/HTTP** export target (`OtlpLogTarget`) for any OpenTelemetry backend. |
| `@spinajs/telemetry` | Prometheus metrics + Apdex + an HTTP request-timing middleware. Metrics, not a log sink — see its own README. |

## Quick start

```ts
import { DI } from "@spinajs/di";
import { Log } from "@spinajs/log";

const log = await DI.resolve(Log, ["my-module"]); // logger named "my-module"

log.info("started");
log.info("user %s logged in", userId);            // printf-style args
log.error(err, "could not connect to %s", host);  // Error first, then message
log.info({ reqId, sku }, "checkout started");      // structured fields (merging object)
```

With no configuration the logger writes every level to a colored console.

## Log levels

Eight levels, lowest to highest severity:

```
trace < debug < info < success < warn < error < fatal < security
```

`success` and `security` are SpinaJS extras (a positive/notice level and a
top-of-scale audit level). A rule's `level` is the **minimum**; lower-severity
messages for that logger are dropped.

Each level also maps to the OpenTelemetry **SeverityNumber** (1–24), emitted by
the JSON/OTLP targets so any observability backend can rank/filter by severity:

| Level | SeverityNumber |
| --- | --- |
| trace | 1 |
| debug | 5 |
| info | 9 |
| success | 11 |
| warn | 13 |
| error | 17 |
| fatal | 21 |
| security | 23 |

## Loggers

- **Named** — `DI.resolve(Log, ["name"])`. The same name returns the same logger.
- **`@Logger` decorator** — inject a logger into a class property:
  ```ts
  import { Logger, Log } from "@spinajs/log";
  class UserService {
    @Logger("UserService") protected Log: Log;
    save() { this.Log.info("saving"); }
  }
  ```
- **Child loggers** — `const child = log.child("db", { pool: 1 });` creates a
  logger named `parent.db` that inherits the parent's variables plus any extra.
- **Per-logger variables** — `log.addVariable("region", "eu");` makes `${region}`
  available in that logger's layouts and structured records.
- **Timers** — `log.timeStart("q"); …; const ms = log.timeEnd("q");` returns the
  elapsed milliseconds.

## Logging API

Every level method (`trace`/`debug`/`info`/`warn`/`error`/`fatal`/`security`/`success`)
accepts three call shapes, dispatched by the **first argument**:

```ts
log.info("plain message");
log.info("formatted %s = %d", name, count);      // printf args
log.error(new Error("boom"), "while saving %s", id); // Error first -> structured `error`
log.info({ reqId: "abc", userId: 42 }, "handled"); // plain object first -> merged fields
```

- **Error first** → the error is serialized into a structured `error` field and
  the message/args follow.
- **Plain object first** (not an `Error`/array) → its keys are merged into the
  entry's variables (available as `${key}` in layouts and as fields in JSON),
  the second argument is the format string.
- **String first** → it is the message / printf format string.

**printf specifiers** (in the message string):

| Spec | Meaning |
| --- | --- |
| `%s` | string |
| `%d` | number |
| `%i` | `parseInt` |
| `%f` | `parseFloat` |
| `%j` / `%o` / `%O` | JSON / object |
| `%%` | literal `%` (consumes no argument) |

Leftover arguments are appended space-separated.

## Layouts / templates

Text targets render each entry through a **layout** string using `${…}`
placeholders. The default layout is:

```
${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})
```

Available constructs:

| Construct | Renders |
| --- | --- |
| `${datetime}` | current date-time |
| `${date:dd_MM_yyyy}` | formatted date (Luxon-style format) |
| `${level}` | upper-case level, e.g. `ERROR` |
| `${message}` | the formatted message |
| `${logger}` | the logger name |
| `${myVar}` | any per-logger / merged / ambient variable |
| `${error:message}` | sub-property access on a variable (here the structured error's `message`) |
| `${?error} … ${/error}` | conditional block — rendered only when `error` is truthy |
| `${callsite}` | the caller's `file:line` (opt-in — see below) |

Set a target's `layout` to override the default, e.g.
`"${datetime} ${level} ${message} @ ${callsite} (${logger})"`.

**`${callsite}`** is captured only when *some* target's layout references it, so
logging stays zero-cost otherwise (no stack is walked). It resolves to
`basename:line` and is best-effort (empty string if the runtime stack can't be
parsed).

## Targets (sinks)

A **target** is where messages go. Each configured target has a `name`
(referenced by rules) and a `type` (the DI key). Common options
(`ICommonTargetOptions`): `name`, `type`, `enabled` (default `true`), `layout`.

> **Per-target filters.** A target definition may carry its own `filters` list
> (same shape as `logger.filters`). These run **only** when writing to that
> target, **after** the logger-level pipeline, and drop/mutate the entry for
> **that target only** — the entry is cloned per target first, so a mutating
> filter (e.g. `WhenRepeatedFilter`'s `(xN)`) never bleeds into other targets:
>
> ```js
> targets: [
>   { name: "Audit", type: "FileTarget",
>     filters: [{ type: "MatchFilter", pattern: "secret", mode: "drop" }] },
>   { name: "Console", type: "ConsoleTarget" }, // still sees everything
> ]
> ```

> **`enabled: false` targets are never instantiated.** A target definition
> marked `enabled: false` is skipped at resolve time — its class is never
> constructed, so a disabled `FileTarget` never opens its file, starts its flush
> timer, or spins up its archive service. A rule that references only disabled
> targets is silently skipped (treated as intentionally not routed); a rule that
> references a target **name that does not exist at all** still throws
> `InvalidOption`.

> **Config shape note:** some targets read their settings **flat** on the target
> definition (Console `theme`/`layout`, `MemoryTarget.limit`, `JsonTarget.stream`),
> while File/JSON-file and the wrapper targets read them **nested under an
> `options` object**. Loki and OTLP accept either. Each example below uses the
> form that target expects.

| `type` | Class | Package | Writes to |
| --- | --- | --- | --- |
| `ConsoleTarget` | `ColoredConsoleTarget` / `BrowserConsoleTarget` | `@spinajs/log` | stdout/stderr (ANSI colors on Node; devtools styling in the browser) |
| `FileTarget` | `FileTarget` | `@spinajs/log` | a file via `@spinajs/fs`, buffered, with rotation/retention/zip |
| `JsonTarget` | `JsonTarget` | `@spinajs/log` | **stdout** as newline-delimited JSON (NDJSON) |
| `JsonFileTarget` | `JsonFileTarget` | `@spinajs/log` | a **file** as NDJSON (inherits FileTarget rotation) |
| `MemoryTarget` | `MemoryTarget` | `@spinajs/log` | an in-memory ring buffer (readable in-process) |
| `BlackHoleTarget` | `BlackHoleTarget` | `@spinajs/log` | nowhere (discards; useful in tests) |
| `SplitGroupTarget` | `SplitGroupTarget` | `@spinajs/log` | fans one target out to many |
| `AutoFlushTarget` | `AutoFlushTarget` | `@spinajs/log` | wraps a target; force-flushes it on high-severity entries |
| `RetryingTarget` | `RetryingTarget` | `@spinajs/log` | wraps a target; retries its `write` on rejection |
| `FallbackGroupTarget` | `FallbackGroupTarget` | `@spinajs/log` | ordered fallback across targets (+ drop-hook) |
| `GraphanaLogTarget` | `GraphanaLokiLogTarget` | `@spinajs/log-source-graphana-loki` | Grafana Loki over HTTP, batched |
| `OtlpLogTarget` | `OtlpLogTarget` | `@spinajs/log-otlp` | any OTLP/HTTP backend at `/v1/logs` |

### Console

```js
{ name: "Console", type: "ConsoleTarget" }
```

Node uses ANSI colors per level (override the palette with a `theme` map);
the browser build maps levels to `console.debug/log/warn/error`.

> **Browser caveat:** because output is formatted and dispatched through the
> logger, browser devtools attribute log lines to the console target, not your
> call site. Use `${callsite}` in the layout if you need the origin.

### File

Writes through the [`@spinajs/fs`](../fs) abstraction, so the active log and its
archives can live on any registered provider (local disk, S3, FTP, …). Options
live under `options`:

```js
{
  name: "File",
  type: "FileTarget",
  options: {
    path: "logs/log_${logger}_${date:dd_MM_yyyy}.txt", // required; variables allowed
    archivePath: "logs/archive",
    maxSize: 1024 * 1024,       // rotate past this many bytes
    compress: true,             // zip archived files
    maxBufferSize: 100,         // buffered messages before a flush
    maxQueueSize: 100000,       // hard in-memory cap; drops oldest if a sink is stuck
    flushInterval: 1000,        // ms; flush a partial buffer at least this often
    archiveStrategy: "SizeLogArchiveStrategy",
    retentionStrategies: ["CountLogRetentionStrategy"],
    maxArchiveFiles: 5,
    maxAge: 7 * 24 * 60 * 60,   // seconds
    archiveInterval: 60,        // seconds between size checks
  },
}
```

| option | default | meaning |
| --- | --- | --- |
| `path` | *required* | active log path, relative to the `fs` provider base path (variables allowed) |
| `archivePath` | log dir | archive directory, relative to the `archiveFs` provider |
| `fs` | `fs-log-default` | provider for the active log (`fs-log-default` is registered automatically at `process.cwd()`) |
| `archiveFs` | = `fs` | provider archives are moved to |
| `archiveStrategy` | `SizeLogArchiveStrategy` | rotation strategy class name |
| `retentionStrategies` | `["CountLogRetentionStrategy"]` | ordered retention strategy class names |
| `maxSize` | `1048576` | rotate when the active log exceeds this many bytes |
| `archiveInterval` | `60` | seconds between size checks |
| `rotate` | — | cron expression for `CronLogArchiveStrategy` (6-field, seconds supported) |
| `compress` | `false` | zip the archived file, then delete the raw copy |
| `maxBufferSize` | `100` | buffered messages before a flush |
| `maxQueueSize` | `100000` | hard cap; oldest buffered messages are dropped past it |
| `flushInterval` | `1000` | periodic flush tick in ms |
| `maxArchiveFiles` | `5` | archives to keep (`CountLogRetentionStrategy`) |
| `maxAge` | `604800` | max archive age in seconds (`AgeLogRetentionStrategy`) |

Writes are buffered and flushed as one batched `fs.append`, guarded by a
write-lock so a rotation never races an append; a failed append is retried
(never silently dropped, up to the `maxQueueSize` cap).

### JSON (stdout) and JSON file

`JsonTarget` emits one JSON object per line to stdout — ideal for container log
collectors (promtail/Loki, Filebeat/Elastic, Datadog, CloudWatch) that index
fields instead of parsing text:

```js
{ name: "Json", type: "JsonTarget", stream: "stdout" } // or "stderr"
```

A record looks like:

```json
{"time":"2026-07-15T…","severityNumber":17,"level":"ERROR","logger":"checkout","message":"save failed","reqId":"abc","error":{"name":"Error","message":"save failed","stack":"…","code":"ECONNREFUSED"}}
```

`JsonFileTarget` writes the same NDJSON to a **file**, reusing all of
FileTarget's rotation/retention/zip (configure it exactly like `FileTarget`
under `options`, with `type: "JsonFileTarget"`). Both stamp `time` at log time
and serialize with a never-throwing, circular-safe stringifier.

### Memory (ring buffer)

Keeps the last `limit` entries in memory so a debug endpoint or a crash handler
can read recent context back in-process:

```js
{ name: "Memory", type: "MemoryTarget", limit: 200 } // default 100
```

```ts
const ring = DI.resolve<MemoryTarget>("MemoryTarget");
ring.getRecords(); // ILogEntry[] (newest last); ring.clear() to empty
```

### BlackHole

```js
{ name: "Null", type: "BlackHoleTarget" } // discards everything
```

### Wrapper targets

Wrappers decorate inner target definitions (given under `options`).

**SplitGroup** — fan one logical target out to many sinks:

```js
{ name: "Multi", type: "SplitGroupTarget", options: { targets: [
  { name: "Console", type: "ConsoleTarget" },
  { name: "File", type: "FileTarget", options: { path: "logs/app.log" } },
]}}
```

**AutoFlush** — force-flush an inner (buffered) target when a high-severity entry
arrives, so a crash-level event is never left buffered:

```js
{ name: "SafeFile", type: "AutoFlushTarget", options: {
  target: { name: "File", type: "FileTarget", options: { path: "logs/app.log" } },
  flushLevel: "error", // default "error"
}}
```

**Retrying** — retry an inner target's `write` on rejection with exponential
backoff + jitter:

```js
{ name: "RetryOut", type: "RetryingTarget", options: {
  target: { name: "Custom", type: "MyTarget" },
  maxAttempts: 3,  // default 3
  delayMs: 100,    // default 100
}}
```

**FallbackGroup** — an ordered list; write advances to the next target when the
primary **rejects** (write-rejection contract), *and* a drop-hook chains entries
a self-healing network target **gives up on** (buffer overflow or a non-retryable
delivery failure) to the next target — a durable fallback for a down sink, with
no duplicates:

```js
{ name: "Durable", type: "FallbackGroupTarget", options: { targets: [
  { name: "Otlp", type: "OtlpLogTarget", options: { endpoint: "http://collector:4318" } },
  { name: "Spill", type: "JsonFileTarget", options: { path: "logs/undelivered.ndjson" } },
]}}
```

### Grafana Loki (`@spinajs/log-source-graphana-loki`)

```js
{ name: "Loki", type: "GraphanaLogTarget", options: {
  host: "http://localhost:3100",
  auth: { username: "admin", password: "admin" }, // optional (unauthenticated Loki allowed)
  labels: { app: "my-app" },
  interval: 3000, bufferSize: 10, maxBufferSize: 1000, timeout: 1000,
}}
```

Batched HTTP push with exponential-backoff + jitter retry (honoring
`Retry-After`, retrying only network errors and 429/502/503/504); non-retryable
errors surface instead of looping. The primary buffer is bounded.

### OTLP (`@spinajs/log-otlp`)

Export to any OpenTelemetry backend (OTel Collector, Grafana/Tempo, Datadog, …):

```js
{ name: "Otlp", type: "OtlpLogTarget", options: {
  endpoint: "http://localhost:4318",       // POSTs to /v1/logs
  headers: { Authorization: "Bearer …" },  // optional
  resource: { "service.name": "my-app" },  // resource attributes
  scopeName: "@spinajs/log",
  interval: 3000, bufferSize: 10, maxBufferSize: 1000, timeout: 5000,
}}
```

Maps each entry to the OTLP Logs model — `severityNumber`, `body`, resource +
record attributes, `traceId`/`spanId` from the request trace context, and a
structured `error` to `exception.type`/`exception.message`/`exception.stacktrace`
semantic attributes. Batched with the same resilience retry as Loki.

## Rules

A **rule** binds a logger-name pattern to a minimum `level` and one or more
`target` names:

```js
{ name: "http/*/controller", level: "info", target: ["Console", "File"] }
```

### Level windows (`maxLevel`)

`level` is the **lower** bound. Add an optional `maxLevel` to route only a level
**window** `[level, maxLevel]` (inclusive) — e.g. warn/error but **not**
fatal/security:

```js
{ name: "*", level: "warn", maxLevel: "error", target: "Ops" }
```

Without `maxLevel` the upper bound defaults to the highest level (`security`), so
a plain min-only rule is unchanged.

Several rules may route to the **same** target with **different** windows; the
target then accepts the **union** of those windows. So two rules `info..info` and
`error..error` to one target deliver `info` and `error` but **not** a `warn`
between them.

> `maxLevel` does **not** lower the per-logger `MinLevel` fast-gate: a call above
> every window still builds the entry and is then filtered out per target — the
> gate only tracks the lowest `level` across rules.

Name matching uses glob semantics:

- `*` — any logger name.
- `prefix*` — names starting with `prefix`.
- `a.b.*` — dotted namespaces.
- an exact name matches only itself.

### Ordered, additive matching (`final`)

Rules are evaluated **in config order**, and matching is **additive** (NLog-style):
**every** rule whose pattern matches a logger applies, so a logger matched by both
`*` and a specific rule routes to **both** (targets are de-duped downstream, so a
target hit by two matching rules still receives each entry once).

A matched rule marked `final: true` **stops** evaluation of any *later* rules; that
final rule and all earlier matched rules still apply.

```js
rules: [
  { name: "db.pool", level: "trace", target: "PoolDebug", final: true }, // stops here
  { name: "*",       level: "info",  target: "Console" },                 // skipped for db.pool
]
```

- `db.pool` matches the first rule, applies it, and stops — the later `*` is **not**
  applied, so `db.pool` routes **only** to `PoolDebug`.
- any other logger doesn't match `db.pool`, falls through, and routes to `Console`.

> **Migration from the old behavior.** Previously a specific rule *dropped* the `*`
> catch-all, so adding a rule for one logger silently **excluded** it from the
> global console/file. Now the specific rule is **additive** — that logger reaches
> both its own target **and** the catch-all. To restore the old "this logger goes
> **only** here" behavior, mark its rule `final: true` and place it **before** the
> `*` catch-all (as above).

## Filters

Filters run in order per logger and can drop or modify entries. Configure a list
under `logger.filters`; each item's `type` is a DI-registered filter. A filter
returns the (possibly modified) entry to keep, or drops it.

```js
logger: {
  filters: [
    { type: "LevelFilter", min: "warn" },
    { type: "MatchFilter", pattern: "healthcheck", mode: "drop" },
    { type: "RateLimitFilter", limit: 100, intervalSeconds: 10 },
    { type: "WhenRepeatedFilter", timeout: 10 },
  ],
  // …targets, rules
}
```

| Filter | Options | Effect |
| --- | --- | --- |
| `WhenRepeatedFilter` | `timeout` (s, default 10), `maxKeys` (default 1024) | collapses identical repeated entries within the window into one, appending `(xN)` when logging resumes |
| `LevelFilter` | `min`, `max` (level names) | keeps only entries whose level is within `[min, max]` |
| `MatchFilter` | `pattern`, `field` (default `message`), `mode` (`keep`/`drop`, default `keep`), `flags` | regex-match a variable; keep on match (or drop, in `drop` mode); an invalid pattern is a no-op |
| `RateLimitFilter` | `limit`, `intervalSeconds`, `key` (optional variable) | fixed-window rate limit; drops overflow, per-key or global |

Filters run **after** the near-zero-cost level gate, so disabled levels never
reach them. The legacy `logger.whenRepeated` option still works (mapped to a
prepended `WhenRepeatedFilter`).

The same filter list can also be attached **per target** (`targets[].filters`) to
filter for one sink only — see [Targets](#targets-sinks). Per-target filters run
**after** the logger-level pipeline on a per-target clone, so a filter that mutates
the entry there never affects other targets.

## Structured logging

Use `JsonTarget`/`JsonFileTarget` (or Loki/OTLP) to emit machine-readable
records. The pieces:

- **Serializer registry** — registered field serializers run when an entry is
  built. The default `error` serializer turns an `Error` into
  `{ name, message, stack, code, signal }`, walking the `.cause` /
  `AggregateError` chain into `stack`. Register your own:
  ```ts
  import { registerSerializer } from "@spinajs/log-common";
  registerSerializer("req", (r: any) => ({ method: r.method, url: r.url }));
  // then: log.info({ req }, "handled")
  ```
  A serializer that throws degrades to `{ serializerError }` — logging never
  crashes the caller.
- **Merging-object fields** — `log.info({ reqId, sku }, "…")` adds `reqId`/`sku`
  as first-class fields.
- **`safeStringify`** — the JSON targets serialize with a never-throwing,
  `[Circular]`-safe stringifier, so a circular field can't break logging.
- **`severityNumber`** — the OTel severity number is included on JSON/OTLP
  records for backend severity ranking.

## Async context & correlation

`LogContext` provides ambient, per-operation variables over an
`AsyncLocalStorage` shared with `@spinajs/http` — so anything logged inside a
request automatically carries its context with zero threading.

```ts
import { LogContext } from "@spinajs/log";

LogContext.with({ requestId: "abc", tenant: "acme" }, async () => {
  // any logger, any depth, across awaits:
  log.info("deep inside"); // entry carries requestId + tenant
});
```

- `LogContext.with(vars, fn)` — run `fn` with `vars` merged onto the current
  context (copy-on-write; nesting accumulates).
- `LogContext.active()` — the current context (or `{}`).
- `LogContext.set(key, value)` — late-bind a value onto the active context.
- `LogContext.bind(fn)` — capture the context and re-attach it to a detached
  callback / event handler.

Only **scalar** values (string/number/boolean/bigint) from the ambient context
are projected into log lines — objects/arrays/Dates are skipped as noise (pass
structured payloads explicitly per call). Inside an HTTP request the context is
`req.storage`, so logs automatically carry `requestId` and `realIp`.

**Trace correlation** — the http `RequestId` middleware continues an inbound W3C
`traceparent` (or starts a new trace) and seeds `traceId`/`spanId` into the
context, so every log line across services shares a trace id (and they surface as
top-level fields on OTLP records). Helpers `parseTraceparent`,
`formatTraceparent`, and `newTraceContext` are exported for custom propagation.

## File archiving

`FileTarget`/`JsonFileTarget` rotate and prune via strategies selected by class
name:

**Rotation** (when to archive) — one strategy:

- `SizeLogArchiveStrategy` — interval timer; rotates when the active log passes `maxSize`.
- `CronLogArchiveStrategy` — rotates on the `rotate` cron expression (6-field, seconds supported).

**Retention** (which archives to delete) — an ordered list, so policies compose:

- `CountLogRetentionStrategy` — keep the newest `maxArchiveFiles`.
- `AgeLogRetentionStrategy` — delete archives older than `maxAge` seconds.

```js
{ name: "File", type: "FileTarget", options: {
  path: "logs/app.log",
  rotate: "0 0 1 * * *",                // 1am daily
  archiveStrategy: "CronLogArchiveStrategy",
  retentionStrategies: ["CountLogRetentionStrategy", "AgeLogRetentionStrategy"],
  maxArchiveFiles: 5,
  maxAge: 7 * 24 * 60 * 60,
  compress: true,
}}
```

Custom strategies extend `LogArchiveStrategy` / `LogRetentionStrategy`, register
in DI, and are named in the config. The browser build omits `FileTarget` and the
archive module (and never pulls in `@spinajs/fs`).

## Runtime level control

Every logger supports a runtime override on top of its rule-derived minimum
level, with a near-zero-cost disabled path (a disabled call returns before
building an entry):

```ts
log.getLevel();            // current effective LogLevel
log.setLevel("error");     // gate everything below error (persists in the browser)
log.setDefaultLevel("info"); // set only if nothing is already overridden/persisted
log.enableAll();           // = setLevel("trace")
log.disableAll();          // silence everything
log.resetLevel();          // back to the rule-derived level
```

In the browser the chosen level persists to `localStorage` (cookie fallback), so
it survives reloads; on Node persistence is a no-op. `setLevel` accepts a level
name or a `LogLevel` value (validated via `normalizeLevel`).

## Configuration reference

A complete `logger` configuration, validated against the schema in
`src/schemas/log.configuration.ts` (`targets` and `rules` are required non-empty
arrays; a target needs `name` + `type`; a rule needs `name` + `level` + `target`):

```js
module.exports = {
  logger: {
    variables: {},
    targets: [
      { name: "Console", type: "ConsoleTarget" },
      { name: "Json", type: "JsonTarget", stream: "stdout" },
      { name: "File", type: "FileTarget", options: {
          path: "logs/log_${logger}_${date:dd_MM_yyyy}.txt",
          archivePath: "logs/archive",
          maxSize: 1024 * 1024,
          compress: true,
          maxBufferSize: 8 * 1024,
          retentionStrategies: ["CountLogRetentionStrategy", "AgeLogRetentionStrategy"],
          maxArchiveFiles: 5,
          maxAge: 7 * 24 * 60 * 60,
      }},
    ],
    filters: [
      { type: "WhenRepeatedFilter", timeout: 10 },
    ],
    rules: [
      { name: "*", level: "info", target: "Console" },        // everything -> console
      { name: "audit*", level: "trace", target: ["Json", "File"] }, // audit loggers -> json + file
    ],
  },
};
```

## Flushing & shutdown

Buffered targets (`FileTarget`, Loki, OTLP) hold entries in an in-memory
`BatchQueue` and drain them on their own tick. To force a drain explicitly:

- **`log.flush()`** — force-drains THIS logger's targets' buffers
  (`Promise<void>`). It calls `forceFlush()` on each target; on a non-buffered
  target that is a harmless no-op. `flush()` does **not** close or dispose the
  target — handle and timer teardown remains the DI container's job.
- **`Log.flushAll()`** — flushes every registered logger (best-effort; never
  rejects). Static.
- **`Log.clearLoggers()`** — flushes all loggers **before** disposing them, so
  buffered entries are written out during teardown rather than relying on the DI
  container disposing the target singletons.

On a **clean** process exit the log bootstrapper registers a Node-only
`beforeExit` hook that runs `Log.flushAll()`. This is best-effort: `beforeExit`
does not fire on hard exits (`process.exit`, signals, crashes), so call
`Log.flushAll()` / `Log.clearLoggers()` yourself in those paths.

## Extending

**Custom target** — extend `LogTarget`, register it under a `type`, implement
`write`. Optionally implement `forceFlush` (for buffered targets) and set
`OnDropped` semantics (see the fallback contract):

```ts
import { LogTarget, ICommonTargetOptions, ILogEntry } from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";
import { format } from "@spinajs/configuration-common";

@Singleton()
@Injectable("MyTarget")
export class MyTarget extends LogTarget<ICommonTargetOptions> {
  public write(entry: ILogEntry): void {
    if (!this.Options.enabled) return;
    const line = format(entry.Variables, this.Options.layout);
    // …deliver `line`… ; reject/throw to signal non-acceptance (Retry/Fallback act on it)
  }
}
```

The `write()` contract: it **may reject** to signal the entry was not accepted —
`RetryingTarget`/`FallbackGroupTarget` act on that. Self-healing targets resolve
and call the optional `OnDropped(entry)` hook for entries they ultimately give
up on, which `FallbackGroupTarget` chains to a durable fallback.

**Custom filter** — extend `LogFilter`, register it under a `type`, implement
`apply` (return the entry to keep, or `null` to drop):

```ts
import { LogFilter, ILogEntry } from "@spinajs/log-common";
import { Injectable } from "@spinajs/di";

@Injectable("OnlyErrors")
export class OnlyErrors extends LogFilter {
  public apply(entry: ILogEntry): ILogEntry | null {
    return entry.Level >= 5 /* Error */ ? entry : null;
  }
}
```

## Package map

```
your code ──> @spinajs/log ( Log service, targets, filters, rules, LogContext )
                    ▲
 low-level pkgs ──> @spinajs/internal-logger  (buffers until config is ready,
                    │                           then replays into @spinajs/log)
                    ▼
              @spinajs/log-common  (contracts: Log, LogTarget, LogFilter,
                                    BatchQueue, serializers, layout variables)

network sinks:  @spinajs/log-source-graphana-loki ( GraphanaLogTarget )
                @spinajs/log-otlp                  ( OtlpLogTarget )
metrics:        @spinajs/telemetry                 ( Prometheus + Apdex + timing )
```

`InternalLogger` exists so packages that load **before** configuration/logging
(DI, configuration) can still log. Those messages buffer and flush into the real
targets once `Configuration` resolves; on process exit any still-buffered
messages print to the console so nothing is lost. Do not use `InternalLogger` in
application code — resolve `Log` instead.
