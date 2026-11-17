---
"@spinajs/tenancy-orm": minor
---

The tenant table. The migration `Tenants_2026_11_16_00_00_00` creates `tenants` (id, slug, name, state, domains, placement, settings, timestamps) on the connection alias `tenancy` (`db.Aliases.tenancy`, default `default`); `TenantModel` maps it. `DbTenantRegistry` is the `TenantRegistry` selected by `tenancy.registry: 'DbTenantRegistry'`: `get(id)`, `find({ slug | domain })`, which compare for equality only, and a paged `list({ states })`; a row with an unknown state or unreadable JSON is never handed out. `TenantStateService.transition(id, to)` moves a tenant along `provisioning -> active <-> suspended -> deleting -> deleted`, or from `provisioning` to `deleting` when provisioning did not finish, refuses any other step and a move that lost a race, and drops the tenant from the registry cache of `@spinajs/tenancy`. Importing the package now creates the `tenants` table with the application's migrations.
