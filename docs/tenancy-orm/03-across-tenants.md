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

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TenantSelectExtension` | `SelectQueryExtension`, `@Injectable` at import | itself | none | Not meant to be replaced |
| `TenantUpdateExtension` | `UpdateQueryExtension`, `@Injectable` at import | itself | none | Not meant to be replaced |
| `TenantDeleteExtension` | `DeleteQueryExtension`, `@Injectable` at import | itself | none | Not meant to be replaced |

`TenantQueryMethods` is the type of the added method. The package augments `ISelectQueryBuilder`, `SelectQueryBuilder`,
`IUpdateQueryBuilder`, `UpdateQueryBuilder`, `IDeleteQueryBuilder` and `DeleteQueryBuilder` of `@spinajs/orm`;
`.acrossTenants()` returns the same builder type (`SameQuery`).

`acrossTenantsReason(builder)` returns the reason a builder carries, or `undefined`. It also reads the mark through an
execution copy made from the marked builder, such as a page of `stream()`, and ignores a mark set on a class prototype.

## Important behaviour

- The reason is required and must not be blank.
- It works inside a tenant and with no scope, and widens that one statement only.
- A clone of a marked select carries the mark (`TenantSelectExtension.onClone`).
- A to-one populate is part of the statement and is widened with it.
- A to-many populate runs as a statement of its own in the scope around it: inside a tenant, the other tenants' rows
  come back with empty related lists.
- An insert has no `.acrossTenants()`: in `runAcrossTenants()` the caller sets the tenant column on every row.
- An update still may not write the tenant column, in any scope.
- On a connection with tenant settings, the first statement on a tenant table pins the transaction's scope: a widened
  statement after one that ran in a tenant throws `TenantSwitchDenied`, and so does a tenant statement after a widened
  one (see [Transactions](04-transactions.md)).

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
