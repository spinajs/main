# Tenant models

A model declared with `@Tenant()` belongs to one tenant per row. Every statement built from the model is confined to the
tenant scope of `@spinajs/tenancy` it runs in, and a statement with no scope throws. This is row mode: all tenants
share one table and a tenant column tells the rows apart.

## How it works

1. `@Tenant()` or `registerTenantModel()` registers the class. A subclass of a registered class is a tenant model too.
2. The Orm resolves `TenantScopeMiddleware` (a `QueryMiddleware`, `order = 80`). Its `beforeQueryExecution` runs for
   every select, insert, update and delete.
3. The middleware reads the statement scope: `.acrossTenants(reason)` on the builder (see
   [Across tenants](03-across-tenants.md)), else `tenantScope()` of `@spinajs/tenancy`.
4. It finds the tenant model the statement targets. A statement that touches no tenant table passes unchanged.
5. With no scope it throws `TenantRequired`.
6. A statement that does not go through the tenant model's own query on its own table is refused inside a tenant and
   passes in the all-tenants scope, except an update that writes the tenant column, which throws `InvalidOperation` in
   every scope (see [What is refused](#what-is-refused)).
7. In a tenant scope:
   - an insert gets the tenant column set on every row; a row that carries another tenant throws `TenantMismatch`;
   - a select, update or delete gets `AND <column> = '<tenant>'` after the caller's conditions, which are grouped first.
8. In the all-tenants scope an insert must set the tenant column on every row (`TenantRequired` otherwise); other
   statements get no tenant predicate, but an update that writes the tenant column, or sets a key that is no declared
   column of the model, still throws `InvalidOperation`.

On a connection with tenant settings, step 4 also applies the [one scope per transaction](04-transactions.md) rule.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Tenant(options?)` | model class | `isolation`, `column`, `rls` | Registers the class and its subclasses as a tenant model |

`registerTenantModel(Model, options?)` does the same for a model of a package you do not own.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `isolation` | `'row' \| 'schema'` | `tenancy.orm.isolation` | `'schema'` throws `NotSupported`: schema placements are not available yet |
| `column` | `string \| false` | `tenancy.orm.column` | Name of the tenant column, `[A-Za-z_][A-Za-z0-9_]*`. `false` throws `InvalidArgument` in row mode |
| `rls` | `boolean` | `tenancy.orm.rls` | Turns on the [transaction rule](04-transactions.md) for the model's connection |

An unknown option, or a value of the wrong type, throws `InvalidArgument` at declaration. Registering a class twice with
the same options is a no-op; with other options it throws `InvalidArgument`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.orm.isolation` | `string` | `row` | `row`, `schema` | Isolation of a model that sets none. `schema` throws `NotSupported` at the first statement on a tenant model |
| `tenancy.orm.column` | `string | false` | `tenant_id` | column name; `false` is refused in row mode, `true` by the schema | Tenant column of a model that sets none |
| `tenancy.orm.rls` | `boolean` | `false` | `true`, `false` | `rls` of a model that sets none |

```json
{ "tenancy": { "orm": { "isolation": "row", "column": "tenant_id", "rls": false } } }
```

The keys are read on every statement, so a reloaded configuration applies at once.

## Schema

The model declares the tenant column itself; the package adds no column and no migration for it.

| Column | Type | Meaning |
| --- | --- | --- |
| `tenant_id` (or the configured name) | should be `varchar(64) not null` and indexed; the package checks only that the column exists | Id of the tenant that owns the row |

A table with no such column is refused at the first statement on the model. Make every unique index of a tenant table
include the tenant column: otherwise an insert, or an insert-or-ignore, tells a caller that a key exists in another
tenant.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TenantScopeMiddleware` | `QueryMiddleware`, registered with `@Injectable(QueryMiddleware)` at import | `TenantScopeMiddleware` | none | Subclass it and override `confineStatement(query, target, scope)`, which runs for a statement of the tenant model on its own table. Every registered `QueryMiddleware` runs, so register the subclass with `DI.register(MyMiddleware).as(QueryMiddleware)` after `DI.unregister(TenantScopeMiddleware)`, before the first query is built, or both run |

`order = 80` puts it ahead of the authz query middlewares (90 to 100), so their filter wraps a statement that is
already confined.

Introspection functions, for tooling and other packages:

| Function | Returns |
| --- | --- |
| `tenantModelOf(model)` | The `TenantModelEntry` of a class or its nearest registered ancestor, or `undefined` |
| `tenantModelOfTable(table)` | The entry of the tenant model that maps `table`, in any letter case, on any connection |
| `tenantModels()` | One entry per ORM model that is or descends from a tenant model and has its own table |

`TenantModelEntry` holds `model` (the registered class), `table` (`''` for an abstract base), `isolation` (`'row'`),
`column` and `rls`, with the model's options laid over `tenancy.orm`.

## What is refused

| Statement | Error |
|---|---|
| any statement on a tenant table with no tenant scope | `TenantRequired` |
| a builder that does not go through the tenant model: no model (`driver.select().from('invoice')`, `truncate`), a model that is no tenant model on a tenant table, a tenant model on another table, a many-to-many populate that involves a tenant model; table names match in any letter case | `NotSupported` inside a tenant; allowed in the all-tenants scope |
| in a select of a tenant model, `populate()` of any to-one relation, and a recursive query (`withRecursive()`, a `@Recursive` relation) | `NotSupported` inside a tenant: the ORM merges a to-one relation's conditions into the statement after the middleware ran, and builds the recursive part without them |
| in a select of a model that is no tenant model, `populate()` of a to-one relation whose target is a tenant model, at any depth of to-one relations | `NotSupported` inside a tenant; load it with a query of its own |
| an upsert (`onDuplicate()`, `orReplace()`, `InsertOrUpdate`, `InsertOrReplace`) on a tenant model | `NotSupported` inside a tenant |
| an update that writes or increments the tenant column. On a model: any key that is no declared column of the model is refused too. Without a model: the tenant column in another letter case, with accents or with surrounding spaces | `InvalidOperation`, in every scope, also when the update does not go through the model |
| an update with no condition | `InvalidOperation` inside a tenant; write `.where(true)` to update every row of the tenant |
| `@Tenant({ isolation: 'schema' })` | `NotSupported`: schema placements are not available yet |

`archive()` writes the whole row back; call it inside the row's tenant.

## What is not checked

The middleware sees query builders, not SQL text. It does not see `sql` templates, `driver.execute` with SQL text, raw
fragments inside a builder, or a `Lazy` condition. `driver.execute(builder)` and `executeStream(builder)` skip the query
middlewares, so a builder run that way is not confined either.

It also does not look into:

- a join you write yourself (`leftJoin(Model)`);
- a sub-select (`whereExist(query)`, `whereIn(column, query)`, `whereExist('relation')`);
- the static `Model.populate(relation, owner)`, which reads through a join the framework builds.

Put the tenant condition into those by hand. Such a statement reads the rows of every tenant, with or without a tenant
scope, and nothing throws.

Schema builders are not checked: a view over a tenant table, or a table clone with data, carries every tenant's rows.
An update without a model (all-tenants scope only) is checked by the spelling of its keys, so a name that only the
database's collation treats as the tenant column is not caught there.

## Important behaviour

- The caller's conditions are grouped before the tenant predicate is added, so an `orWhere` cannot leave the tenant.
- A hasMany populate and every page of `stream()` are statements of their own and are confined the same way.
- The model instance does not get the tenant written back after an insert; read it again when you need the value.
- Only a plain-object insert (`Model.insert({...})`) gets the tenant column from the middleware. A model instance
  (`new Model(...).insert()`, `Model.create()`, `getOrCreate()`, `Model.insert(instance)`) needs the tenant column set on
  it, on every driver: the ORM checks not-null columns when it converts the instance, before the middleware runs.
- Saving a loaded relation list (`relation.update()` of a one-to-many or many-to-many list) is an upsert, so it throws
  `NotSupported` inside a tenant.
- In the all-tenants scope an upsert is not refused: its update half can rewrite the tenant column, and `orReplace()` can
  replace another tenant's row.
- Import the package before the Orm resolves: the Orm adds `.acrossTenants()` and registers `TenantModel` and its
  migration only then. The middleware applies to every builder created after the import.

## Patterns and antipatterns

```ts
// Don't: the relation's conditions are merged after the middleware ran, so this throws NotSupported in a tenant
await Invoice.where('Id', 7).populate('customer');

// Do: load the to-one target with a query of its own
const invoice = await Invoice.where('Id', 7).first();
const customer = await Customer.where('Id', invoice.customer_id).first();
```

```ts
// Don't: a model instance is checked for not-null columns before the middleware sets the tenant
await new Invoice({ status: 'open' }).insert();

// Do: insert a plain object, or set the column on the instance yourself
await Invoice.insert({ status: 'open' });
```

## Examples

### Keep invoices per tenant

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

`@Tenant({ column: 'org' })` names another column. A subclass of a tenant model is a tenant model, also under an
abstract `@Tenant()` base.

## Related

- [Across tenants](03-across-tenants.md): widen one statement to every tenant.
- [Transactions](04-transactions.md): one tenant scope per transaction on a connection with tenant settings.
- [`@spinajs/orm`](../orm/README.md): query middlewares and builders the package hooks into.
