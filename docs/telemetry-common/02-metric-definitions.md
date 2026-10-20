# Metric definitions

`Metrics.defineMetrics(prefix, defs)` turns a list of plain `MetricDef` objects into prom-client counters, gauges, histograms and summaries on the shared registry. Use it to declare a package's or an app's metric set in one place and get back a map of ready-to-record metrics.

## How it works

`defineMetrics(prefix, defs)` runs, for each `def` in order:

1. **Name.** The full name is `` `${prefix}_${def.name}` ``. An empty prefix gives `_<name>`.
2. **Replace.** When the registry already holds a metric with that name, `registry.removeSingleMetric(name)` removes it.
3. **Build.** A new prom-client metric is created with `{ name, help, labelNames: def.labelNames ?? [], registers: [registry] }`:
   - `counter` → `Counter`, `gauge` → `Gauge`;
   - `histogram` → `Histogram` with `buckets: def.buckets ?? linearBuckets(1, 1, 10)`;
   - `summary` → `Summary`, with `percentiles` only when `def.percentiles` is set.
4. **Collect.** The metric goes into the result map under the **unprefixed** `def.name`.
5. **Return** the `MetricMap`.

Errors stop the loop and throw:

- an unknown `type` throws `Error("unknown metric type '<type>' for metric '<full name>'")`;
- prom-client throws `Invalid metric name` for a name outside `[a-zA-Z_:][a-zA-Z0-9_:]*` (eg. a prefix `my-app`), an invalid label name, or `le is a reserved label keyword` for a histogram label `le`.

The call is all-or-nothing: metrics built before the failing definition are removed again, and any metric it replaced is put back.

## Types

### `MetricDef`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | required | Name without the prefix; also the key in the returned map. |
| `help` | `string` | required | The `# HELP` text. |
| `type` | `MetricType` | required | `'counter'`, `'gauge'`, `'histogram'` or `'summary'`. |
| `labelNames` | `string[]` | `[]` | Allowed label names. Recording with a label not listed throws `Added label "<x>" is not included in initial labelset`. |
| `buckets` | `number[]` | `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]` | Histogram upper bounds. Ignored for other types. |
| `percentiles` | `number[]` | prom-client's `[0.01, 0.05, 0.5, 0.9, 0.95, 0.99, 0.999]` | Summary quantiles. Ignored for other types. |

`MetricDef` has no field for prom-client's `collect` callback, `aggregator`, or summary `maxAgeSeconds` / `ageBuckets`. Build those metrics on [the raw registry](04-registry-access.md).

### Other exports

| Export | Kind | Meaning |
| --- | --- | --- |
| `MetricType` | type | `'counter' \| 'gauge' \| 'histogram' \| 'summary'` |
| `AnyMetric` | type | `Counter<string> \| Gauge<string> \| Histogram<string> \| Summary<string>` |
| `MetricMap<T extends AnyMetric = AnyMetric>` | type | `Record<string, T>`: unprefixed name → metric |
| `Counter`, `Gauge`, `Histogram`, `Summary`, `Registry` | type-only re-exports of prom-client | Narrow map entries and type fields without a direct prom-client dependency |

The prom-client classes are re-exported with `export type`. Use them in type positions and casts (`map['x'] as Gauge<string>`). They do **not** exist at runtime from this package: `instanceof Gauge` and `new Registry()` need a direct `prom-client` import.

## Important behaviour

- **A second call rebuilds and resets.** Calling `defineMetrics()` again with a name that exists removes the old metric and registers a new one at zero. Code still holding the old object keeps writing to a metric no longer in the registry: those writes never render. Define each set once per `Metrics` instance.
- **Prefixes are global.** Two packages that define the same full name replace each other's metric. The shipped prefixes are `http`, `perf`, `orm` and `socket`.
- **The map is not typed per key.** Every entry is `AnyMetric`; cast to the concrete type before calling `inc()`, `set()` or `observe()`.
- **The default histogram buckets suit seconds from 1 to 10.** A millisecond or sub-second histogram without `buckets` puts every sample in the first bucket. `@spinajs/orm` and `@spinajs/http-socket` pass their own seconds buckets for this reason.
- **Labels are fixed at definition.** You cannot add a label name to a defined metric; define it again with the new `labelNames`.

## Best practices

- Export the prefix and the unprefixed keys as constants, as `@spinajs/orm` does with `ORM_METRIC_PREFIX` and `ORM_METRIC_KEY_*`. Tests and dashboards then share one spelling.
- Cache the map per `Metrics` instance in a `WeakMap<Metrics, MetricMap>`. `DI.clearCache()` then gives you a fresh set on the fresh registry, with no stale module-level flag.
- Wrap resolution in `try`/`catch` in library code and return `null`: recording a metric must not fail a query or a request.
- Keep label values low-cardinality: route templates, command names, outcome codes. Never user ids or raw paths; `@spinajs/http-socket` maps unknown command names to `'<unknown>'` for this reason.
- Follow Prometheus naming: `_total` for counters, a unit suffix (`_seconds`, `_bytes`) for histograms.

## Patterns and antipatterns

```ts
// Don't: defines the set on every call; each call resets every value to zero
function recordExport(rows: number): void {
  const map = DI.resolve(Metrics).defineMetrics('export', defs);
  (map['rows_total'] as Counter<string>).inc(rows);
}

// Do: define once per Metrics instance, then reuse
const DEFINED = new WeakMap<Metrics, MetricMap>();
function exportMetrics(): MetricMap {
  const service = DI.get(Metrics) ?? DI.resolve(Metrics);
  let map = DEFINED.get(service);
  if (!map) {
    map = service.defineMetrics('export', defs);
    DEFINED.set(service, map);
  }
  return map;
}
```

```ts
// Don't: a user id as a label value creates one series per user
(map['downloads_total'] as Counter<string>).inc({ user: req.user.id });

// Do: a bounded label set
(map['downloads_total'] as Counter<string>).inc({ plan: req.user.plan });
```

## Examples

### Publish metrics from a library

The pattern `@spinajs/orm` and `@spinajs/http-socket` use: prefix and keys as constants, the set built once per `Metrics` instance, and `null` when metrics are unavailable.

```ts sample
import { DI } from '@spinajs/di';
import { Metrics, MetricDef, MetricMap, Counter, Histogram } from '@spinajs/telemetry-common';

export const MAILER_METRIC_PREFIX = 'mailer';
export const MAILER_KEY_SENT = 'sent_total';
export const MAILER_KEY_SEND_SECONDS = 'send_seconds';

const MAILER_METRIC_DEFS: MetricDef[] = [
  { name: MAILER_KEY_SENT, help: 'Emails handed to the transport, by outcome', type: 'counter', labelNames: ['transport', 'outcome'] },
  {
    name: MAILER_KEY_SEND_SECONDS,
    help: 'Seconds spent in the transport send call',
    type: 'histogram',
    labelNames: ['transport'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  },
];

const DEFINED = new WeakMap<Metrics, MetricMap>();

export function mailerMetrics(): MetricMap | null {
  try {
    const service = DI.get(Metrics) ?? DI.resolve(Metrics);
    let map = DEFINED.get(service);

    if (!map) {
      map = service.defineMetrics(MAILER_METRIC_PREFIX, MAILER_METRIC_DEFS);
      DEFINED.set(service, map);
    }

    return map;
  } catch {
    return null;
  }
}

export async function sendWithMetrics(transport: string, send: () => Promise<void>): Promise<void> {
  const map = mailerMetrics();
  const timer = (map?.[MAILER_KEY_SEND_SECONDS] as Histogram<string> | undefined)?.startTimer({ transport });

  try {
    await send();
    (map?.[MAILER_KEY_SENT] as Counter<string> | undefined)?.inc({ transport, outcome: 'ok' });
  } catch (err) {
    (map?.[MAILER_KEY_SENT] as Counter<string> | undefined)?.inc({ transport, outcome: 'error' });
    throw err;
  } finally {
    timer?.();
  }
}

void sendWithMetrics('smtp', async () => {
  // transport.send(message)
});
```

### Track checkout latency percentiles with a summary

```ts sample
import { DI } from '@spinajs/di';
import { Metrics, Summary } from '@spinajs/telemetry-common';

const shop = DI.resolve(Metrics).defineMetrics('shop', [
  {
    name: 'checkout_seconds',
    help: 'Checkout duration in seconds',
    type: 'summary',
    labelNames: ['payment'],
    percentiles: [0.5, 0.9, 0.99],
  },
]);

const checkout = shop['checkout_seconds'] as Summary<string>;
checkout.observe({ payment: 'card' }, 1.8);
checkout.observe({ payment: 'card' }, 0.9);

DI.resolve(Metrics).render().then((text) => console.log(text));
// shop_checkout_seconds{quantile="0.5",payment="card"} ...
```

## Related

- [Metrics service](01-metrics-service.md): the singleton and registry these metrics land in.
- [Registry access](04-registry-access.md): metrics `MetricDef` cannot describe.
- [ORM observability](../orm/13-observability-and-resilience.md): the `orm_*` set built with this API.
- [Socket observability](../http-socket/16-observability.md): the `socket_*` set built with this API.
