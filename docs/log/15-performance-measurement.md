# Performance measurement

`Perf` times code and counts events; every measurement goes to all registered `PerfSink`s. The default sink, `LogMetricSink`, writes slow and failed spans and a per-request rollup as log entries on the `perf` logger, through your normal rules and targets.

## How it works

1. You measure with `Perf.measure(name, fn, opts?)`, `Perf.start(name, opts?).end(fields?)`, the `@Measure()` method decorator, `Perf.count()` or `Perf.value()`.
2. `Perf` times spans with `performance.now()`. A span that throws or rejects is still recorded, with `error` set, and the error is rethrown.
3. It reads the per-request scope from the perf scope backend. `LogBotstrapper` installs `wirePerfScope()`, which reads `perf` from the ambient [`LogContext`](12-async-context-and-tracing.md) (in `@spinajs/http`, `req.storage.perf`). Spans and counts add to `scope.byName[name]` (`count`, `totalMs`, `maxMs`).
4. It emits an `IPerfMetric` to every sink from `DI.resolve(Array.ofType(PerfSink))`, resolved on the first emit and memoized. A sink that throws is ignored.
5. At the end of a request, `Perf.flushScope(scope, { labels, totalMs })` (called by `@spinajs/http`) hands an `IPerfRollup` to each sink's `onScopeEnd()`.
6. `LogMetricSink.collect()`:
   - failed span: `error` entry `"<name> failed after <ms>ms"`;
   - span at or over its threshold (`thresholds[name] ?? thresholds.default`, `0` = never slow): `overThresholdLevel` entry `"Slow <name>: <ms>ms"`;
   - other spans: dropped, unless `logUnderThreshold` selects them, then `underThresholdLevel`;
   - counters and values: `trace` entries when `logCounters` is `true`.
   A `sql` field is flattened, cut to `sqlMaxLength` and appended to the message (` - <sql>`); bindings stay in fields only.
7. `LogMetricSink.onScopeEnd()` writes one `info` entry: `perf rollup [<requestId>]: orm.query x12 87ms, http.request x1 240ms`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Measure(name?, opts?)` | method (sync or async) | `name`: metric name, default `<ClassName>.<method>`; `opts`: `{ labels?, fields? }` | Wraps the method in `Perf.measure()`. |

## API

| Member | Effect |
| --- | --- |
| `Perf.measure(name, fn, opts?)` | Times `fn`, returns its result (a promise for async `fn`). |
| `Perf.start(name, opts?)` | Returns `{ end(fields?) }`; `end()` records once, later calls do nothing. |
| `Perf.count(name, delta = 1, labels?)` | Adds `delta` to the scope count, emits a `counter`. |
| `Perf.value(name, n, labels?)` | Emits a `value` (gauge-like); not added to the scope. |
| `Perf.flushScope(scope, extra?)` | Sends the rollup to sinks' `onScopeEnd()`. No-op for a missing scope. |
| `Perf.Enabled` | Kill switch; `false` makes `measure`, `count`, `value` pass-throughs. `start().end()` still records. |
| `Perf.refreshSinks()` | Forget the memoized sink list; the next emit resolves it again. |
| `setPerfScopeBackend(backend)` | Replaces the scope reader, `{ get(): IPerfScope \| null }`. |
| `wirePerfScope()` | Installs the `LogContext`-backed backend (what `LogBotstrapper` does). |

`labels` are low-cardinality dimensions (safe as Prometheus labels); `fields` are rich payload for logs only (SQL text, row counts).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.perf.enabled` | `boolean` | `true` | | `false`: `LogMetricSink` ignores everything. Other sinks still receive metrics. |
| `logger.perf.thresholds` | `Record<string, number>` | `{ 'orm.query': 200, 'http.request': 1000, default: 0 }` | ms per metric name | Slow threshold; `default` for unlisted names; `0` never slow. |
| `logger.perf.overThresholdLevel` | `string` | `'warn'` | `trace` `debug` `info` `warn` `error` | Level of slow spans. |
| `logger.perf.underThresholdLevel` | `string` | `'trace'` | same | Level of spans selected by `logUnderThreshold`. |
| `logger.perf.logUnderThreshold` | `boolean \| string[]` | `false` | | `true`: log every span; a list: only those names. |
| `logger.perf.logCounters` | `boolean` | `false` | | Log counters and values at `trace`. |
| `logger.perf.sqlMaxLength` | `number` | `2000` | | Max SQL characters in the message. |

```js
module.exports = {
  logger: {
    perf: {
      thresholds: { 'orm.query': 100, 'http.request': 500, 'reports.build': 3000, default: 0 },
      logUnderThreshold: ['orm.query'],
      underThresholdLevel: 'debug',
    },
    rules: [
      { name: 'perf', level: 'debug', target: 'PerfFile', final: true },
      { name: '*', level: 'info', target: 'Console' },
    ],
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Perf sink | `PerfSink`, resolved as `Array.ofType(PerfSink)`; each keeps its own lifetime | `LogMetricSink` (`@Singleton()`) | `PromMetricSink`, `InMemoryPerfSink` (`@spinajs/telemetry`) | Add a sink with `@Injectable(PerfSink)`; see [Custom perf sinks](16-custom-perf-sinks.md). Remove the log sink with `DI.unregister(LogMetricSink)` or `logger.perf.enabled: false`. |
| Perf scope backend | `setPerfScopeBackend()`, module-level | `wirePerfScope()` (reads `LogContext.active().perf`) | no-op backend (browser, no bootstrap) | Call `setPerfScopeBackend()` after the bootstrap loop. |

### Perf scope backend

Install your own backend when rollups should come from somewhere other than the http request store, eg. one rollup per queue job.

```ts sample
import { IPerfScope, LogContext, Perf, setPerfScopeBackend } from '@spinajs/log';

// Call after the bootstrap loop: LogBotstrapper.bootstrap() installs its own backend.
export function installJobPerfBackend(): void {
  setPerfScopeBackend({ get: () => (LogContext.active().jobPerf as IPerfScope | undefined) ?? null });
}

export async function runJobWithRollup(jobId: string, job: () => Promise<void>): Promise<void> {
  const scope: IPerfScope = { requestId: jobId, byName: {} };
  const started = performance.now();

  await LogContext.with({ jobPerf: scope }, job);

  Perf.flushScope(scope, { labels: { kind: 'job' }, totalMs: performance.now() - started });
}
```

`scalarContext()` drops objects, so `jobPerf` never shows up as a log field.

## Important behaviour

- The sink list is resolved once, on the first measurement. A sink module imported later is ignored until `Perf.refreshSinks()`.
- `LogMetricSink` logs through the `perf` logger, so rules decide where perf lines go; with only a `*` rule at `info`, under-threshold `trace` lines are dropped by the level gate at almost no cost.
- `fields` are merged into the log entry, so a field named `message`, `level` or `logger` breaks the entry (see [Logging API](01-logging-api.md#important-behaviour)).
- Without `LogBotstrapper.bootstrap()`, there is no scope: spans are still emitted, rollups are empty.
- `Perf.Enabled = false` skips `measure`, `count` and `value` only.
- The configuration schema lists `enabled`, `thresholds`, `overThresholdLevel`, `underThresholdLevel` and `logCounters`; `logUnderThreshold` and `sqlMaxLength` work but are not described there.

## Best practices

- Name metrics `area.operation` (`orm.query`, `reports.build`) so thresholds and `logUnderThreshold` lists stay readable.
- Put SQL, ids and payload sizes in `fields`, never in `labels`.
- Route the `perf` logger to its own target with a `final` rule when you turn on `logUnderThreshold`.

## Patterns and antipatterns

```ts
// Don't: a user id as a label explodes Prometheus series in PromMetricSink
Perf.measure('profile.load', load, { labels: { userId } });

// Do
Perf.measure('profile.load', load, { labels: { plan }, fields: { userId } });
```

## Examples

### Find slow report builds

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { Measure, Perf } from '@spinajs/log';

interface IReportRow {
  region: string;
  revenue: number;
}

// config: logger.perf.thresholds['reports.build'] = 3000
@Singleton()
@Injectable()
export class SalesReportService {
  @Measure('reports.build', { labels: { report: 'sales' } })
  public async build(year: number, load: (year: number) => Promise<IReportRow[]>): Promise<Map<string, number>> {
    const rows = await load(year);
    Perf.count('reports.rows', rows.length, { report: 'sales' });

    const span = Perf.start('reports.aggregate');
    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.region, (totals.get(row.region) ?? 0) + row.revenue);
    }
    span.end({ regions: totals.size });

    return totals;
  }
}
```

## Related

- [Custom perf sinks](16-custom-perf-sinks.md): receive the metrics yourself.
- [Async context and tracing](12-async-context-and-tracing.md): the store the default scope backend reads.
- `@spinajs/telemetry`: Prometheus and in-memory sinks; `@spinajs/http`: the per-request rollup middleware; `@spinajs/orm-sql` and its dialects: emit `orm.query` spans.
