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

`import '@spinajs/tenancy/queue'` (needs `@spinajs/queue`) registers a message hook: a message emitted inside a tenant scope carries it in the header `x-spinajs-tenant`, and its handler runs in that scope, also after a retry or a redelivery. A value the caller or a hook of a higher order wrote under that name is replaced: the hook writes after them. The header is as trustworthy as the broker: whoever can publish to it, or call `QueueClient.emit()` directly, can name any tenant. `@Job({ tenancy: 'required' })` refuses a message that names no single tenant (dead-lettered, reason `tenant_required`); `@Job({ tenancy: 'none' })` always runs with no scope.

## CLI

With `@spinajs/tenancy` installed, every `spinajs` command accepts `--tenant <id>` (the command runs inside that tenant once the registry knows it as active; an unknown or inactive tenant, or an id written in another case or with spaces, stops the command with `TenantUnavailable`) or `--all-tenants <reason>` (it runs across all tenants, and the reason is logged); an option given twice stops the command. Without either, the command runs with no tenant scope, also when the process that runs the CLI has one, and code that touches a tenant model throws `TenantRequired`. The CLI finds the hook through this package's `system.dirs.cli`; nothing is imported by the application. The options belong to the program, so a command's own option of the same name never receives a value, not even its default. The scope covers the command's `execute()` and the work it starts; its `onCreation`, `onPreAction` and `onPostAction` run outside it.
