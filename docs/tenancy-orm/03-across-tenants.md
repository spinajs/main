# Across tenants

`.acrossTenants(reason)` runs one select, update or delete of a [tenant model](02-tenant-models.md) over the rows of
every tenant. Use it for one statement; use `runAcrossTenants(reason, fn)` of `@spinajs/tenancy` for a block of them.

## How it works

1. `TenantSelectExtension`, `TenantUpdateExtension` and `TenantDeleteExtension` are registered when the package is
   imported; the Orm adds `.acrossTenants()` to the select, update and delete builders when it resolves.
2. `.acrossTenants(reason)` checks its arguments and marks the builder with the reason:
   - a blank or missing reason throws `InvalidArgument`;
   - a builder that is not on a tenant model throws `InvalidOperation`.
3. `TenantScopeMiddleware` reads the mark with `acrossTenantsReason(builder)` and runs the statement in the all-tenants
   scope `{ kind: 'all', reason }` instead of the current scope.

```ts
const overdue = await Invoice.where('status', 'overdue').acrossTenants('nightly dunning report');
```

The mark widens the builder it is called on and nothing else. A [sub-query](02-tenant-models.md#sub-queries) of a
widened statement is still confined to the current tenant, or throws `TenantRequired` with no tenant scope; mark the
sub-query to widen it too:

```ts
// every tenant's invoices whose code is a code of the current tenant
await Invoice.query().acrossTenants('duplicate codes').whereIn('code', Invoice.query().select('code'));
// every tenant's invoices whose code is a code of any tenant
await Invoice.query().acrossTenants('duplicate codes').whereIn('code', Invoice.query().select('code').acrossTenants('duplicate codes'));
```

In the callback of a relation list's `sync()`, `this.acrossTenants(reason)` widens the statement that removes the
orphans to every tenant; without it that statement stays in the current tenant:

```ts
await invoice.Lines.sync(function () {
  this.acrossTenants('merge of duplicate tenants');
});
```

For a many-to-many list that statement is the junction delete, so the junction model must be a tenant model, and it is
the only statement the call widens: `sync()` first reads the existing links in the current scope, and the callback
cannot reach that read. The call therefore needs a tenant scope and a connection without tenant settings. Otherwise run
the whole `sync()` inside `runAcrossTenants(reason, fn)`:

```ts
await runAcrossTenants('merge of duplicate tenants', () => invoice.Tags.sync());
```

The links `sync()` adds are plain inserts on the junction model: inside a tenant they get that tenant's column, and
inside `runAcrossTenants` every new link needs the tenant column in its junction data, or `sync()` throws
`TenantRequired` and rolls back:

```ts
invoice.Tags.add(tag, { tenant_id: 't2' });
await runAcrossTenants('merge of duplicate tenants', () => invoice.Tags.sync());
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TenantSelectExtension` | `SelectQueryExtension`, `@Injectable` at import | itself | none | Not meant to be replaced |
| `TenantUpdateExtension` | `UpdateQueryExtension`, `@Injectable` at import | itself | none | Not meant to be replaced |
| `TenantDeleteExtension` | `DeleteQueryExtension`, `@Injectable` at import | itself | none | Not meant to be replaced |

`TenantQueryMethods` is the type of the added method. The package augments `ISelectQueryBuilder`, `SelectQueryBuilder`,
`IUpdateQueryBuilder`, `UpdateQueryBuilder`, `IDeleteQueryBuilder`, `DeleteQueryBuilder` and
`IRelationSyncStatement` (the `this` of a `sync()` callback) of `@spinajs/orm`; `.acrossTenants()` returns the same
builder type (`SameQuery`), and `this`'s type for the callback's statement.

`acrossTenantsReason(builder)` returns the reason a builder carries, or `undefined`. It also reads the mark through an
execution copy made from the marked builder, such as a page of `stream()`, and ignores a mark set on a class prototype.

## Important behaviour

- The reason is required and must not be blank.
- On a select, update or delete builder it works inside a tenant and with no scope, and widens that one statement only,
  not its sub-queries. A sub-query in the `sync()` callback (`this.acrossTenants(reason).whereIn(column, query)`) stays
  in the current tenant unless it is marked too; on a connection with tenant settings the two scopes in one transaction
  throw `TenantSwitchDenied`.
- In the `sync()` of a many-to-many list only the junction delete is widened. The read of existing links before it
  runs in the current scope: with no scope it throws `TenantRequired`, and on a connection with tenant settings it pins
  the tenant, so the widened delete throws `TenantSwitchDenied`. There, run the whole `sync()` inside
  `runAcrossTenants(reason, fn)`.
- The links a many-to-many `sync()` or `update()` adds are inserts: inside a tenant they are written for that tenant, and
  in `runAcrossTenants()` the junction data of every new link must carry the tenant column (`TenantRequired` otherwise).
  An unsaved member that is a tenant model still cannot be written: it is inserted as a model instance and as an upsert
  (see [Tenant models](02-tenant-models.md)).
- A clone of a marked select carries the mark (`TenantSelectExtension.onClone`).
- A to-one populate is part of the statement and is widened with it.
- A to-many populate runs as a statement of its own in the scope around it: inside a tenant, the other tenants' rows
  come back with empty related lists.
- An insert has no `.acrossTenants()`: in `runAcrossTenants()` the caller sets the tenant column on every row.
- An update still may not write the tenant column, in any scope.
- On a connection with tenant settings, the first statement of a transaction pins its scope: a widened statement after
  one that ran in a tenant throws `TenantSwitchDenied`, and so does a tenant statement after a widened one (see
  [Transactions](04-transactions.md)).
- On PostgreSQL and PGlite, on a connection with tenant settings, `.acrossTenants()` throws `InvalidOperation` inside
  a tenant scope and with no scope: the database is told the scope around the statement, not the statement's own mark.
  Run the statement inside `runAcrossTenants(reason, fn)`.

## Patterns and antipatterns

```ts
// Don't: the whole block leaves the tenant, so every statement in it reads all tenants
await runAcrossTenants('count overdue', async () => {
  const overdue = await Invoice.where('status', 'overdue');
  await notifyOwner(overdue);
  await Invoice.update({ status: 'reminded' }).where('status', 'overdue');
});

// Do: widen the one statement that needs it
const overdue = await Invoice.where('status', 'overdue').acrossTenants('nightly dunning report');
```

## Related

- [Tenant models](02-tenant-models.md): what a statement in a tenant scope gets.
- [Transactions](04-transactions.md): a widened statement inside a transaction.
