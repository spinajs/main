# `@spinajs/tenancy-orm`

Confines the rows of a tenant in the ORM, and keeps the tenants themselves in a table. A model declared with `@Tenant()`
can only be read and written inside a tenant scope of `@spinajs/tenancy`, and every statement built from the model is
limited to that tenant.

It does **not** filter raw SQL, joins and sub-selects you write, or schema builders: see
[What is not checked](02-tenant-models.md#what-is-not-checked). Schema-per-tenant isolation is not available yet.

## Install

```sh
npm install @spinajs/tenancy-orm
```

Import the package in the app entry before the boot: the Orm installs its query middleware, its query extensions, the
tenant model and its migration when it resolves.

```ts
import '@spinajs/tenancy-orm';
```

## Features

| Feature | What it does |
| --- | --- |
| [The tenant table](01-tenant-table.md) | `DbTenantRegistry` over the `tenants` table, and `TenantStateService` for the tenant states |
| [Tenant models](02-tenant-models.md) | `@Tenant()` models whose statements are confined to the current tenant by `TenantScopeMiddleware` |
| [Across tenants](03-across-tenants.md) | `.acrossTenants(reason)` widens one select, update or delete to every tenant |
| [Transactions](04-transactions.md) | One tenant scope per transaction on a connection with tenant settings |

## Quick start

```ts
import { Column, Connection, Index, Model, ModelBase, Primary } from '@spinajs/orm';
import { runInTenant } from '@spinajs/tenancy';
import { Tenant } from '@spinajs/tenancy-orm';

@Connection('default')
@Model('invoice')
@Index(['tenant_id'])
@Tenant()
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;

  public status: string;
}

await runInTenant('t1', async () => {
  await Invoice.insert({ status: 'open' });          // tenant_id is set to 't1'
  await Invoice.where({ status: 'open' });           // WHERE (status = 'open') AND tenant_id = 't1'
});
```

## Configuration

```json
{
  "tenancy": { "registry": "DbTenantRegistry", "orm": { "isolation": "row", "column": "tenant_id", "rls": false } },
  "db": { "Aliases": { "tenancy": "default" } }
}
```

- `tenancy.orm.*`: see [Tenant models](02-tenant-models.md#configuration).
- `tenancy.registry` and `db.Aliases.tenancy`: see [The tenant table](01-tenant-table.md).

## Related packages

- [`@spinajs/orm`](../orm/README.md): the query middlewares, builders and migrations this package plugs into.
- `@spinajs/tenancy`: the tenant scope (`runInTenant`, `runAcrossTenants`), the `TenantRegistry` contract and the
  tenant errors.
