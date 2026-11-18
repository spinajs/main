# `@spinajs/tenancy-tracing`

Puts the tenant of the current scope of `@spinajs/tenancy` on every span of a SpinaJS application.

- `import '@spinajs/tenancy-tracing'` once. When Configuration resolves, a `TenantSpanProcessor` is attached to the `@spinajs/tracing` hub; nothing else to register.
- A span started in a tenant scope gets `spina.tenant.id` (`SpinaAttr.Tenant`) set to the tenant id; in the all-tenants scope (`runAcrossTenants`) to `'*'`; without a scope, no attribute.
- The processor only decorates spans another processor records (an exporter, Studio): attached alone, tracing stays id-only.
- An app that owns its OpenTelemetry SDK adds `new TenantSpanProcessor()` to that SDK.
- The tenant id leaves the process with every exported span: use opaque tenant ids, not customer names or slugs, when traces go to a third party.
