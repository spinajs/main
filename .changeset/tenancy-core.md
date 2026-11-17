---
"@spinajs/tenancy": minor
"@spinajs/log": minor
"@spinajs/tracing": minor
---

New package `@spinajs/tenancy`: the tenant scope of the current unit of work. `runInTenant(tenant, fn)` and `runAcrossTenants(reason, fn)` set it in the request store the framework shares; `currentTenant()`, `requireTenant()` and `tenantScope()` read it. No scope is not "all tenants": `requireTenant()` throws `TenantRequired`, and switching from one tenant to another without leaving through `runAcrossTenants` throws `TenantSwitchDenied`. Also the ports `TenantRegistry`, `TenantResolver` and `TenantAccess`.

`@spinajs/log`: a log line written inside a tenant scope carries the field `Tenant` (the tenant id, or `*` across tenants). `@spinajs/tracing`: `SpinaAttr.Tenant` (`spina.tenant.id`). Nothing changes for an application without `@spinajs/tenancy`.
