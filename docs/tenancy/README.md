# `@spinajs/tenancy`

The tenant scope of a SpinaJS application: which tenant the current request, message or job belongs to. It also holds the tenant registry, the access check that lets a principal enter a tenant, and a runner that visits every tenant.

It does **not** read tenants from HTTP requests or sockets: [`@spinajs/tenancy-http`](../tenancy-http/README.md) does that on top of this package. It does **not** filter database queries by tenant, and it depends on neither the ORM, `@spinajs/http` nor `@spinajs/authz`. No scope is **not** "all tenants": code that needs a tenant throws `TenantRequired` when none is set.

## Install

```sh
npm install @spinajs/tenancy
```

## Features

| Feature | What it does |
| --- | --- |
| [Tenant scope](01-tenant-scope.md) | `runInTenant`, `runAcrossTenants`, `tenantScope`, `currentTenant`, `requireTenant`; the `Tenant` key of the shared request store and the authz cache it drops |
| [Scope guards and entry-point glue](02-scope-guards-and-entry-points.md) | `onTenantScopeChange` guards that can refuse a change of scope; `applyTenantScope` for middleware that owns the request store |
| [Tenant registries](03-tenant-registries.md) | `TenantRegistry`, `ConfigTenantRegistry`, `MemoryTenantRegistry`, `ListedTenantRegistry`, the `CachedTenantRegistry` behind `tenantRegistry()` and its `invalidate()` |
| [Tenant admission and access](04-admission-and-access.md) | `admitTenant` checks that a proposed tenant is known, active and open to the principal; the `TenantAccess` and `TenantResolver` ports |
| [Running across tenants](05-running-across-tenants.md) | `forEachTenant` runs a job once per tenant, each in its own scope, and reports the failures |
| [Configuration](06-configuration.md) | Every `tenancy.*` key, its default and the configuration schema |

## Quick start

Two tenants listed in the configuration; a host name is admitted, and the work runs inside that tenant.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { admitTenant, requireTenant, runInTenant } from '@spinajs/tenancy';

export class ShopConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      tenancy: {
        tenants: [
          { id: 'acme', name: 'Acme Inc', domains: ['shop.acme.example'] },
          { id: 'globex', name: 'Globex', state: 'suspended' },
        ],
      },
    };
  }
}

DI.register(ShopConfiguration).as(Configuration);

export async function invoicePrefixFor(host: string): Promise<string> {
  // TenantUnavailable for an unknown host or a tenant that is not active
  const tenant = await admitTenant({ domain: host });
  return runInTenant(tenant.id, async () => `INV-${requireTenant().id.toUpperCase()}`);
}
```

## Related packages

- [`@spinajs/tenancy-http`](../tenancy-http/README.md): resolves the tenant of an HTTP request or a socket connection, admits it with `admitTenant` and writes the scope with `applyTenantScope`; reads `tenancy.http.*`.
- [`@spinajs/authz`](../authz/README.md): shares the request store; a new tenant scope starts with an empty authz request cache, and `runWithPrincipal` keeps the tenant.
- [`@spinajs/log`](../log/README.md): log lines carry the scope as `Tenant`: the tenant id, or `*` for the cross-tenant scope.
- [`@spinajs/configuration`](../configuration/README.md): the `tenancy` schema and the config-selected registry and access check.
- [`@spinajs/di`](../di/README.md): the shared `AsyncLocalStorage` and the named registrations of `TenantRegistry` and `TenantAccess`.
- `@spinajs/principal`: the `Principal` that `TenantAccess.canEnter` and `admitTenant` receive.
