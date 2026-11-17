# @spinajs/tenancy-orm

Confines the rows of a tenant in the ORM. A model declared with `@Tenant()` can only be read and written inside a
tenant scope of `@spinajs/tenancy`, and every statement built from the model is limited to that tenant.

Import the package in the app entry before the boot: the Orm installs its query middleware and its query extension
when it resolves.

```ts
import '@spinajs/tenancy-orm';
```

## Declaring a tenant model

The model declares the tenant column itself; `@Tenant()` names it. The default name is `tenant_id`
(`tenancy.orm.column`), the type is `varchar(64) not null`, and the column wants an index.

```ts
import { Column, Connection, Index, Model, ModelBase, Primary } from '@spinajs/orm';
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
```

`@Tenant({ column: 'org' })` names another column. `registerTenantModel(Model, options)` declares a model of a package
you do not own. A subclass of a tenant model is a tenant model, also under an abstract `@Tenant()` base. A table that
has no such column is refused at the first statement on the model.

## What happens to a statement

```ts
import { runAcrossTenants, runInTenant } from '@spinajs/tenancy';

await runInTenant('t1', async () => {
  await Invoice.where({ status: 'open' });           // WHERE (status = 'open') AND tenant_id = 't1'
  await Invoice.insert({ status: 'open' });          // tenant_id is set to 't1'
  await Invoice.update({ status: 'void' }).where('Id', 7);
});

await Invoice.where({ status: 'open' });             // throws TenantRequired: no tenant scope

await runAcrossTenants('nightly billing', async () => {
  await Invoice.query();                             // every tenant, nothing added
});
```

- The caller's conditions are grouped before the tenant predicate is added, so an `orWhere` cannot leave the tenant.
- An insert that carries another tenant throws `TenantMismatch`. In the all-tenants scope an insert sets the column itself.
- A hasMany populate and every page of `stream()` are statements of their own and are confined the same way.
- The model instance does not get the tenant written back after an insert; read it again when you need the value.

### One statement across tenants

```ts
const overdue = await Invoice.where('status', 'overdue').acrossTenants('nightly dunning report');
```

`.acrossTenants(reason)` exists on select, update and delete builders of a tenant model. The reason is required. It
works inside a tenant and with no scope, and it widens that one statement only: a clone made from it keeps it, but a
populated relation runs as a statement of its own in the scope around it.

## What is refused

| Statement | Error |
|---|---|
| any statement on a tenant table with no tenant scope | `TenantRequired` |
| a builder that does not go through the tenant model: no model (`driver.select().from('invoice')`, `truncate`), a model that is no tenant model on a tenant table, a tenant model on another table, a many-to-many populate that involves a tenant model; table names match in any letter case | `NotSupported` inside a tenant; allowed in the all-tenants scope |
| in a select of a tenant model, `populate()` of any to-one relation, and a recursive query (`withRecursive()`, a `@Recursive` relation) | `NotSupported` inside a tenant: the ORM merges a to-one relation's conditions into the statement after the middleware ran, and builds the recursive part without them |
| in a select of a model that is no tenant model, `populate()` of a to-one relation whose target is a tenant model, at any depth of to-one relations | `NotSupported` inside a tenant; load it with a query of its own |
| an upsert (`onDuplicate()`, `orReplace()`, `InsertOrUpdate`, `InsertOrReplace`) on a tenant model | `NotSupported` inside a tenant |
| an update that writes or increments the tenant column, in any letter case | `InvalidOperation`, in every scope |
| an update with no condition | `InvalidOperation` inside a tenant; write `.where(true)` to update every row of the tenant |
| `@Tenant({ isolation: 'schema' })` | `NotSupported`: schema placements are not available yet |

`archive()` writes the whole row back; call it inside the row's tenant.

## What is not checked

The middleware sees query builders, not SQL text. It does not see `sql` templates, `driver.execute` with SQL text, raw
fragments inside a builder, or a `Lazy` condition. `driver.execute(builder)` and `executeStream(builder)` skip the query
middlewares, so a builder run that way is not confined either. In this release it also does not look into a join you
write yourself (`leftJoin(Model)`) or into a sub-select (`whereExist(query)`, `whereIn(column, query)`), nor into the
static `Model.populate(relation, owner)`, which reads through a join the framework builds: put the tenant condition into
those by hand until they are covered. Such a statement reads the rows of every tenant, with or without a tenant scope,
and nothing throws. Schema builders are not checked: a view over a tenant table, or a table clone with data, carries
every tenant's rows.

## Transactions

On a connection whose tenant models declare row level security (`@Tenant({ rls: true })` or `tenancy.orm.rls: true`),
one transaction has one tenant scope. `runInTenant()` and `runAcrossTenants()` throw `TenantSwitchDenied` when they
would change the scope while such a transaction is open, and so does a statement on a tenant table that runs in another
scope than the first such statement of the transaction (`.acrossTenants()` included). Entering the scope the transaction already has is no
change. Enter the scope first, then open the transaction.

`carriesTenantSettings(driver)` tells whether a connection is one. The package registers the check with
`onTenantScopeChange()` of `@spinajs/tenancy` when it loads; `stopTransactionScopeGuard()` removes it for a tool that
must run without it, and the check of each statement still holds then.

## Configuration

```json
{ "tenancy": { "orm": { "isolation": "row", "column": "tenant_id", "rls": false } } }
```
