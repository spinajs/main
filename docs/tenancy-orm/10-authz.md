# Tenants in authz

`@spinajs/tenancy-orm/authz` connects tenancy to `@spinajs/authz`: a tenant is the resource `tenant:<id>`, roles are
given inside a tenant, and entering a tenant is the permission `tenant:enter`.

```ts
import '@spinajs/tenancy-orm';
import '@spinajs/tenancy-orm/authz';
```

`@spinajs/authz` and `@spinajs/authz-orm` are optional peers of `@spinajs/tenancy-orm`: install them when you import
the entry.

## Roles and permissions

`@spinajs/tenancy-orm` ships them as configuration (a package config file), so they exist whether or not the entry is
imported; nothing holds them until you assign them at a `tenant` scope. Change or extend them in your own configuration
like any role.

| Role | Grants | Assignable at |
| --- | --- | --- |
| `tenant.member` | `tenant:enter` (a subject set: its holders can be assigned as a group) | `tenant` |
| `tenant.admin` | `tenant.member`, `tenant:members.add`, `tenant:members.remove`, `tenant:settings.manage` | `tenant` |
| `tenant.owner` | `tenant.admin`; the last owner of a tenant cannot be removed | `tenant` |

At a `tenant` scope `AuthzAdmin` checks a grant with `tenant:members.add`, any other assignment or set change with
`tenant:members.remove`, and a scope attribute change with `tenant:settings.manage`.

```ts
await authz.admin().execute(owner, [{ kind: 'assignment.grant', subject: { type: 'user', id: 'u7' }, role: 'tenant.admin', scope: { type: 'tenant', id: 'acme' } }], { reason: 'onboarding' });
```

A role held at `tenant:acme` gives nothing at `tenant:globex`: a `tenant.admin` of acme cannot add members to globex.

## Who may enter a tenant

Importing the entry registers `AuthzTenantAccess`, and `@spinajs/tenancy` uses it when `tenancy.access` is unset:
`canEnter(principal, tenant)` is `can(principal, 'tenant:enter', { type: 'tenant', id })` in the domain
`authz.orm.domain` names (default `root`). `principal.attributes.tenants` is no longer read; set
`tenancy.access: 'PrincipalAttributeTenantAccess'` to keep that rule.

- A principal that holds `tenant:enter` at another tenant only, or no tenant role at all, is refused
  (`TenantUnavailable` with `reason: 'forbidden'` from `admitTenant`).
- `canEnter` refuses a forged `system` principal (a copy of `SYSTEM`) and `UNATTENDED`. `admitTenant` asks it only for
  an authenticated principal, so anonymous and `UNATTENDED` callers are admitted to an active tenant as before.
- `SYSTEM` enters every tenant: authz allows it everything, by identity. The attribute rule refused it.
- A role whose grants match `tenant:enter` by glob (`*`, `tenant:*`, `*:enter`) gives entry wherever it is held. Held at
  `$global`, that is every tenant, and `tenantsOf` lists all of them. Narrow such roles, or deny `tenant:enter`.
- A configuration error (for example `authz.orm.domain` names a domain that does not exist) makes `canEnter`,
  `admitTenant` and `tenantsOf` reject. A fault of the assignment store refuses instead: `canEnter` is `false`,
  `admitTenant` throws `forbidden` and `tenantsOf` lists nothing. Once the store answers again, access returns.
- `canEnter` answers authz only and does not read the tenant state; `admitTenant` and `tenantsOf` admit and list active
  tenants only.
- A revoke through `AuthzAdmin` takes effect at once. A change that does not reach this process's change bus (another
  node without a shared bus, a direct database edit) takes up to `authz.cache.ttlSeconds` (60 s by default). A suspended
  tenant is admitted by `admitTenant` until `tenancy.registryCacheMs` (5 s by default) passes.
- Import the entry before the first `admitTenant()`, `tenantAccess()` or `tenantRegistry()` call: `@spinajs/tenancy`
  picks the access check once per container.

## A tenant switcher

```ts
import { tenantsOf } from '@spinajs/tenancy-orm/authz';

const tenants = await tenantsOf(principal);   // the active tenants it may enter, in registry order
```

`tenantsOf` checks every active tenant of the registry, 100 per `checkAll` call. A tenant that is not active is never
listed, even by a registry that ignores the state filter.
