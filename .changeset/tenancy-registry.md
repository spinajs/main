---
"@spinajs/tenancy": minor
---

`@spinajs/tenancy`: the registry side. `ConfigTenantRegistry` (tenants listed under `tenancy.tenants`) and `MemoryTenantRegistry`; `tenancy.registry` and `tenancy.access` pick the `TenantRegistry` and the `TenantAccess` by name; `tenantRegistry()` answers the registry behind a cache (`tenancy.registryCacheMs`, default 5000) with `invalidate(id)`; `admitTenant()` applies "known, active, may enter"; `forEachTenant()` runs a function in every tenant with a concurrency limit and reports the failures. The configuration schema of `tenancy` registers at import.
