# Transactions

On a connection with tenant settings, one transaction has one tenant scope. A connection has tenant settings when one
of its tenant models declares row level security: `@Tenant({ rls: true })`, or `tenancy.orm.rls: true` for every model
that sets nothing.

On PostgreSQL and PGlite such a connection also tells the database the tenant of every statement
(`TenantSessionSettings`), for the table's row level security. On other dialects `rls: true` only turns on this rule.

## How it works

Two checks keep the scope, one at the scope change and one at each statement:

1. When the package loads, it registers `refuseScopeChangeInTransaction` with `onTenantScopeChange()` of
   `@spinajs/tenancy`. `runInTenant()` and `runAcrossTenants()` then throw `TenantSwitchDenied` when they would change
   the scope while a transaction is open on any connection with tenant settings.
2. `TenantScopeMiddleware` pins the scope of the first statement of each open transaction, on any table: a select on a
   shared table can join a tenant table. A later statement in another scope throws `TenantSwitchDenied`.
   `.acrossTenants()` counts as the all-tenants scope here: after a widened statement, every later statement of the
   transaction that is not widened throws, one on a shared table too. Under
   [row level security](06-row-level-security.md) this holds after a widened statement that was refused with
   `InvalidOperation` as well: it pinned the scope before it was refused.

Entering the scope the transaction already has is no change.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.orm.rls` | `boolean` | `false` | `true`, `false` | `rls` of a tenant model that sets none; see [Tenant models](02-tenant-models.md#configuration) |

## Services and extension points

| Function | What it does |
| --- | --- |
| `carriesTenantSettings(driver)` | `true` when a tenant model with `rls: true` is on the connection `driver` |
| `sendsTenantSettings(driver)` | `carriesTenantSettings` and PostgreSQL or PGlite, for `driver` or the primary of a read replica |
| `TenantSessionSettings` | A `ConnectionSessionSettings` that sends `spina.tenant` and `spina.tenant_all` where `sendsTenantSettings` holds; nothing outside a scope |
| `stopTransactionScopeGuard()` | Removes the check of step 1, for a tool that must run without it. The check of step 2 still holds for model statements; raw SQL inside the transaction keeps the tenant the transaction began with, because the database was told that tenant at `BEGIN` |

## Important behaviour

- The scope keys are `none`, `all` and `tenant:<id>`; the error names the old and the new key and the connection.
- A connection registered under several names or aliases is checked once.

## Patterns and antipatterns

```ts
// Don't: the scope changes inside the open transaction and throws TenantSwitchDenied
await driver.transaction(async () => {
  await runInTenant('t1', async () => {
    await Invoice.insert({ status: 'open' });
  });
});

// Do: enter the scope first, then open the transaction
await runInTenant('t1', () =>
  driver.transaction(async () => {
    await Invoice.insert({ status: 'open' });
  }),
);
```

## Related

- [Tenant models](02-tenant-models.md): the `rls` option.
- [Across tenants](03-across-tenants.md): `.acrossTenants()` inside a transaction.
- [Row level security](06-row-level-security.md): what the tenant settings are for.
