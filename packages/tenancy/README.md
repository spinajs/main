# `@spinajs/tenancy`

The tenant scope of a SpinaJS application: which tenant the current request, message or job belongs to.

- `runInTenant(tenant, fn)` and `runAcrossTenants(reason, fn)` set the scope; `currentTenant()`, `requireTenant()` and `tenantScope()` read it. No scope is not "all tenants": code that needs a tenant throws `TenantRequired`.
- Inside one tenant, `runInTenant` of another throws `TenantSwitchDenied`; leave through `runAcrossTenants(reason)` first.
- Ports: `TenantRegistry`, `TenantResolver`, `TenantAccess`.
- Code that writes the `Tenant` store key itself (entry-point glue) writes only scopes made by `tenantScopeOf` or `allTenantsScope`, which validate and freeze them.
- A guard registered with `onTenantScopeChange` is also called for a change that changes nothing (no scope to no scope, all tenants to all tenants), so it compares `kind` and the tenant id itself.
- A new scope starts with an empty authz request cache; re-entering the tenant one is already in keeps it.

The scope lives in the request store the framework already shares, so `runAs` keeps it and log lines carry it as `Tenant`. This package depends on neither the ORM, http nor authz; `@spinajs/tenancy-http` and `@spinajs/tenancy-orm` build on it.

## Registry and access

- `tenancy.registry` names the `TenantRegistry` (default `ConfigTenantRegistry`, the tenants listed under `tenancy.tenants`; `MemoryTenantRegistry` for tests). `tenantRegistry()` answers it behind a cache of `tenancy.registryCacheMs` (5000) that has `invalidate(id)`.
- `tenancy.access` names the `TenantAccess` (default `PrincipalAttributeTenantAccess`: the principal's `attributes.tenants` holds the tenant id).
- `admitTenant(proposal, principal)` answers the record of a tenant that is known, active and open to the principal, or throws `TenantUnavailable`.
- `forEachTenant(fn, { concurrency, states })` runs `fn` in every tenant and reports the failures.

## Queue

`import '@spinajs/tenancy/queue'` (needs `@spinajs/queue`) registers a message hook: a message emitted inside a tenant scope carries it in the header `x-spinajs-tenant`, and its handler runs in that scope, also after a retry or a redelivery. A value the caller or an earlier hook wrote under that name is replaced, and no other hook may write it. The header is as trustworthy as the broker: whoever can publish to it, or call `QueueClient.emit()` directly, can name any tenant. `@Job({ tenancy: 'required' })` refuses a message that names no single tenant (dead-lettered, reason `tenant_required`); `@Job({ tenancy: 'none' })` always runs with no scope.

A message runs only while its tenant is active: the hook admits the tenant through the registry first, as `admitTenant` does for a request. A tenant that is unknown, `provisioning`, `suspended`, `deleting` or `deleted` is refused for good (dead-lettered, reason `tenant_unavailable`, no retry), so a tenant cannot run its own jobs until it is `active`. A registry that throws refuses the message too, as an ordinary failure: a job is retried within its `RetryCount`.
