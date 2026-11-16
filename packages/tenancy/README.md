# `@spinajs/tenancy`

The tenant scope of a SpinaJS application: which tenant the current request, message or job belongs to.

- `runInTenant(tenant, fn)` and `runAcrossTenants(reason, fn)` set the scope; `currentTenant()`, `requireTenant()` and `tenantScope()` read it. No scope is not "all tenants": code that needs a tenant throws `TenantRequired`.
- Inside one tenant, `runInTenant` of another throws `TenantSwitchDenied`; leave through `runAcrossTenants(reason)` first.
- Ports: `TenantRegistry`, `TenantResolver`, `TenantAccess`.

The scope lives in the request store the framework already shares, so `runAs` keeps it and log lines carry it as `Tenant`. This package depends on neither the ORM, http nor authz; `@spinajs/tenancy-http` and `@spinajs/tenancy-orm` build on it.
