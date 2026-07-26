# @spinajs/telemetry-common

The metric abstraction shared by `@spinajs/telemetry` and by packages that must publish metrics
without taking on the HTTP stack.

`@spinajs/telemetry` depends on `@spinajs/http`, `@spinajs/log`, `@spinajs/validation` and
`@spinajs/configuration` — it serves `/metrics`, `/health` and the telemetry JSON api. A package
that only wants to *record* a metric, such as `@spinajs/orm` publishing connection-pool gauges,
must not drag any of that underneath itself.

So this package holds exactly the part that needs nothing but `@spinajs/di` and `prom-client`:

- `Metrics` — a `@Singleton()` wrapper over a PRIVATE prom-client `Registry`, with the declarative
  `defineMetrics( prefix, defs )` factory and an async Prometheus text renderer,
- `MetricDef` / `MetricType` / `AnyMetric` / `MetricMap`,
- the prom-client metric types, re-exported so consumers need no direct prom-client dependency.

`@spinajs/telemetry` re-exports all of it, so `import { Metrics } from '@spinajs/telemetry'` keeps
working and both packages share ONE `Metrics` class identity — which matters, because DI resolves
the singleton by that identity and a second copy would mean a second, separate registry.

Same pattern as `@spinajs/configuration-common` and `@spinajs/log-common`.
