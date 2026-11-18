# `@spinajs/tenancy`

The tenant scope of a SpinaJS application: which tenant the current request, message or job belongs to.

- `runInTenant(tenant, fn)` and `runAcrossTenants(reason, fn)` set the scope; `currentTenant()`, `requireTenant()` and `tenantScope()` read it. No scope is not "all tenants": code that needs a tenant throws `TenantRequired`.
- Inside one tenant, `runInTenant` of another throws `TenantSwitchDenied`; leave through `runAcrossTenants(reason)` first.
- Ports: `TenantRegistry`, `TenantResolver`, `TenantAccess`.
- Code that writes the `Tenant` store key itself (entry-point glue) writes only scopes made by `tenantScopeOf` or `allTenantsScope`, which validate and freeze them.
- A guard registered with `onTenantScopeChange` is also called for a change that changes nothing (no scope to no scope, all tenants to all tenants), so it compares `kind` and the tenant id itself.
- A new scope starts with an empty authz request cache; re-entering the tenant one is already in keeps it.

The scope lives in the request store the framework already shares, so `runAs` keeps it and log lines carry it as `Tenant`. This package depends on neither the ORM, http nor authz; `@spinajs/tenancy-http` and `@spinajs/tenancy-orm` build on it.
