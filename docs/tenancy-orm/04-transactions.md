# Transactions

On a connection with tenant settings, one transaction has one tenant scope. A connection has tenant settings when one
of its tenant models declares row level security: `@Tenant({ rls: true })`, or `tenancy.orm.rls: true` for every model
that sets nothing.

`rls: true` creates no policy and applies no session setting in this release; it only turns on this rule.

## How it works

Two checks keep the scope, one at the scope change and one at each statement:

1. When the package loads, it registers `refuseScopeChangeInTransaction` with `onTenantScopeChange()` of
   `@spinajs/tenancy`. `runInTenant()` and `runAcrossTenants()` then throw `TenantSwitchDenied` when they would change
   the scope while a transaction is open on any connection with tenant settings.
2. `TenantScopeMiddleware` pins the scope of the first statement on a tenant table in each open transaction. A later
   statement on a tenant table in another scope throws `TenantSwitchDenied`. `.acrossTenants()` counts as the
   all-tenants scope here.

Entering the scope the transaction already has is no change. A statement on a shared table pins nothing.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.orm.rls` | `boolean` | `false` | `true`, `false` | `rls` of a tenant model that sets none; see [Tenant models](02-tenant-models.md#configuration) |

## Services and extension points

| Function | What it does |
| --- | --- |
| `carriesTenantSettings(driver)` | `true` when a tenant model with `rls: true` is on the connection `driver` |
| `stopTransactionScopeGuard()` | Removes the check of step 1, for a tool that must run without it. The check of step 2 still holds |

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
