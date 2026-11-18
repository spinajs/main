# `@spinajs/tenancy-tracing`

Puts the tenant of the current [`@spinajs/tenancy`](../tenancy/README.md) scope on every span of a SpinaJS application, as the `spina.tenant.id` attribute (`SpinaAttr.Tenant` of [`@spinajs/tracing`](../tracing/README.md)). Importing the package is the whole setup.

It does **not** export spans: an exporter such as [`@spinajs/telemetry-otel`](../telemetry-otel/README.md) does. It does **not** decide the tenant: it reads the scope that `runInTenant`, `runAcrossTenants` or `@spinajs/tenancy-http` set.

## Install

```sh
npm install @spinajs/tenancy-tracing
```

## How it works

1. `import '@spinajs/tenancy-tracing'` registers `TenantTracingBootstrapper`.
2. Once Configuration resolves, the bootstrapper attaches one `TenantSpanProcessor` to the `@spinajs/tracing` hub as an enricher: it decorates the spans other processors record and does not make the hub record spans by itself.
3. When a span starts, the processor reads the scope with `tenantScope()` and sets `spina.tenant.id`:

| Scope when the span starts | `spina.tenant.id` |
| --- | --- |
| One tenant (`runInTenant('acme', ...)`, a tenant route) | the tenant id, `acme` |
| All tenants (`runAcrossTenants(reason, ...)`, an `@AllTenants` route) | `*` |
| No scope | not set |

## Important behaviour

- A span gets the scope that is current when it **starts**. The HTTP server span starts before `TenantMiddleware` sets the scope and has no `spina.tenant.id`; spans started after it, such as the route span and the queries of the action, have it.
- Each span reads the scope for itself, so every child span of a tenant carries the attribute, not only the root.
- With only this processor on the hub, tracing stays id-only: no span is recorded until an exporter or Studio is attached.
- A scope that cannot be read never fails a span: the span is created without the attribute.
- `*` is never a tenant id (ids are `a-z`, `0-9`, `_` and `-`), so a query for `spina.tenant.id = "*"` finds only cross-tenant work. The reason given to `runAcrossTenants` is not exported.
- When an app registered its own OpenTelemetry SDK before SpinaJS (`tracingState().owner === 'external'`), there is no hub and nothing is attached: add `new TenantSpanProcessor()` to that SDK.

## Privacy

The tenant id leaves the process with every exported span and stays in the tracing backend for its retention period, often with a third party. A tenant id that names the customer (`acme`, `globex-gmbh`) tells everyone who reads the traces which customer made each request. When traces leave your infrastructure, give tenants opaque ids (`t7f3k9q2`) and keep the readable name and slug in the tenant record, which never reaches a span.

## Quick start

Import the package once, next to the exporter. Every span started inside the tenant then carries `spina.tenant.id = acme`, with no code in the job.

```ts sample
import '@spinajs/tenancy-tracing';
import { runInTenant } from '@spinajs/tenancy';
import { withSpan } from '@spinajs/tracing';

export async function rebuildSearchIndex(tenantId: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    await withSpan('search.rebuild', {}, async () => {
      // spans started here, and their children, carry spina.tenant.id
    });
  });
}
```

## Examples

### An app that owns its OpenTelemetry SDK

```ts sample
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { TenantSpanProcessor } from '@spinajs/tenancy-tracing';

// The tenant processor comes first, so the exporter sees the attribute from the start of the span.
export const provider = new BasicTracerProvider({
  spanProcessors: [new TenantSpanProcessor(), new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
```

## Related packages

- [`@spinajs/tenancy`](../tenancy/README.md): the tenant scope, `runInTenant`, `runAcrossTenants`, `tenantScope`.
- [`@spinajs/tracing`](../tracing/README.md): the hub the processor is attached to, and the `SpinaAttr` keys.
- [`@spinajs/tenancy-http`](../tenancy-http/README.md): sets the scope of a request or socket connection.
- [`@spinajs/log`](../log/12-async-context-and-tracing.md): the same tenant as the `Tenant` field of log lines.
