# `@spinajs/tracing`

OpenTelemetry bootstrap for SpinaJS: context manager, W3C propagation and one tracer provider with pluggable span processors.

These pages document only the span attribute keys; the rest of the package is not documented yet.

## Install

```sh
npm install @spinajs/tracing
```

## Features

| Feature | What it does |
| --- | --- |
| [Span attribute names](01-span-attributes.md) | `SpinaAttr`: the `spina.*` attribute keys, with the packages that set each; `spina.tenant.id` is set by none and is for your own spans |

## Quick start

```ts sample
import { SpinaAttr, withSpan } from '@spinajs/tracing';

export async function renderInvoice(tenantId: string, invoiceId: number): Promise<void> {
  await withSpan('invoice.render', { attributes: { [SpinaAttr.Tenant]: tenantId, 'invoice.id': invoiceId } }, async () => {
    // render and store the invoice
  });
}
```

## Related packages

- [`@spinajs/tenancy`](../tenancy/README.md): the tenant scope whose id `SpinaAttr.Tenant` names.
- [`@spinajs/log`](../log/12-async-context-and-tracing.md): the same tenant as the `Tenant` field of log lines.
- [`@spinajs/telemetry-otel`](../telemetry-otel/README.md): tracing service and span processors.
