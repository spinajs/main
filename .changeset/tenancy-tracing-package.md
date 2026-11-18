---
"@spinajs/tenancy-tracing": minor
---

New package `@spinajs/tenancy-tracing`: importing it puts the tenant on every span. `TenantSpanProcessor` sets `spina.tenant.id` (`SpinaAttr.Tenant`) when a span starts: the tenant id in a tenant scope, `'*'` in the all-tenants scope, nothing without a scope. A SERVER span started without a scope, such as the HTTP server span, gets the attribute when the request's scope is applied under it. It reads the scope with `tenantScope()` and never fails span creation when the scope cannot be read. `TenantTracingBootstrapper` attaches it to the `@spinajs/tracing` hub as an enricher once Configuration resolves, so it tags the spans an exporter records and, attached alone, keeps tracing id-only. An app that owns its OpenTelemetry SDK adds `new TenantSpanProcessor()` to that SDK.
