# Perf metrics

`OtelPerfSink` is a `PerfSink`: it receives every `Perf.count`, `Perf.measure`, `Perf.start` and `Perf.value` of every
package (authz's `authz.cache.l2.hit`, email's `email.sent`, the ORM's `orm.query`) and records it as an
OpenTelemetry metric of the same name, exported over OTLP/HTTP.

| `Perf` | OpenTelemetry instrument |
| --- | --- |
| `count(name, delta, labels)` | monotonic `Counter`, `add(delta)` |
| `measure(name, fn)`, `start(name).end()` | `Histogram` in `ms` |
| `value(name, n)` | `Gauge`: the last value per attribute set |

Importing the package registers the sink; it does nothing until:

```json
{
  "tracing": { "serviceName": "billing-api" },
  "otel": { "metrics": { "enabled": true, "endpoint": "https://otel.highlight.io:4318/v1/metrics", "exportIntervalMs": 60000 } }
}
```

## Configuration

| Key | Type | Default | Values | Used for |
| --- | --- | --- | --- | --- |
| `otel.metrics.enabled` | `boolean` | `false` | `true`, `false` | Whether the sink exports. `false`: no provider, no exporter, no timer |
| `otel.metrics.endpoint` | `string` | `'https://otel.highlight.io:4318/v1/metrics'` | Full OTLP/HTTP metrics URL, path included: an `http:` or `https:` URL | `url` of the `OTLPMetricExporter`. Credentials go in `OTEL_EXPORTER_OTLP_METRICS_HEADERS` (for example `authorization=Bearer …`); userinfo and a query string in the URL are not sent, and the logs show the endpoint without them |
| `otel.metrics.exportIntervalMs` | `integer` | `60000` | Milliseconds, at least `1000` | Interval of the `PeriodicExportingMetricReader`; one export, its retries included, ends after 5 s |

The schema `otel.metrics` checks the three keys at boot. The switch is `otel.metrics.enabled` alone: metrics are
exported also when `otel.enabled` or `tracing.enabled` is `false`. The sink reads the keys once, at the first metric
after the configuration resolved; changing them later has no effect. A disabled sink then costs one property read per
measurement.

The metrics carry the resource of the traces: `tracing.serviceName` and `tracing.resourceAttributes` of
`@spinajs/tracing`, so one service name covers both signals. `otel.serviceName` and `otel.resourceAttributes` are not
read.

## What is exported

Only the name, the value and the `labels` of a measurement. Its `fields` (SQL text, bindings, template names), its
`requestId` and its `error` stay in the logs, and the per-request rollup (`onScopeEnd`, labelled by route) is not
exported at all.

`labels` are meant to be low-cardinality: a driver, a cache name, a domain, never an id. The sink bounds them anyway:

| Bound | Limit | Past it |
| --- | --- | --- |
| Attributes per measurement | 8 | the labels after the eighth are left out |
| Length of a string attribute value | 128 characters | the value is cut |
| Series (attribute sets) per metric name | 100 | further sets add to one series with the attribute `otel.metric.overflow: true` |
| Metric names | 256 | the measurement is dropped and counted |

A dropped measurement adds one to the counter `spinajs.perf.dropped`, attribute `reason`: `instruments` past the name
limit, `value` for a value that is not a finite number or a negative counter delta.

## Failures

Recording a measurement only updates the sink's in-memory aggregation; the export runs on the reader's own timer
(unreferenced, so it never keeps the process alive). A collector that is down, slow or answers with an error loses
that interval's export and never reaches the code that measured. The first failed export of an outage logs one
`warn` on the `otel` logger (`otel metrics export to <endpoint> failed`); the next failures are not logged until an
export succeeds. The OpenTelemetry diagnostic logger also gets one error per failed interval, but it is silent unless
the application installs one (`diag.setLogger`). An `otel.metrics.endpoint` that is not a URL logs `otel metrics export not started` once at `error` and
leaves the sink inactive.

`@spinajs/tracing` owns the tracer provider and has no meter provider, so the sink keeps a private `MeterProvider`
and never registers a global one. Disposing the container disposes the sink: it exports what is left, waits for that
at most 5 s, stops the timer and shuts the provider down. Nothing it started keeps the process alive afterwards, except
a last request to a collector that does not answer, which ends at the same 5 s. A second dispose does nothing, and a
metric that arrives after it starts nothing.
