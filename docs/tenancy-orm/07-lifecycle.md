# Tenant lifecycle

The lifecycle of a tenant is written in the columns that the migration `Tenants_2026_12_01_00_00_00` adds to
`tenants`: `lifecycle` (the steps of the running operation), `suspension` and the lease of the operation. A row of
`TenantModel` reads the two records with `row.lifecycleRecord()` and `row.suspensionRecord()`; both refuse a record
they cannot read with `InvalidOperation` instead of taking it as empty.

```ts
const row = await TenantModel.where('id', 'acme').first();
const failed = row?.lifecycleRecord().operation?.failed; // { step, message, at } of a provisioning that stopped
```

`TenantLifecycle` creates tenants; importing `@spinajs/tenancy-orm` registers `DefaultTenantLifecycle`. An operation
names its tenant and runs outside a tenant scope (`TenantSwitchDenied` inside one). This version provisions row-mode
tenants only: a `placement` is refused, and `suspend()`, `resume()`, `export()` and `delete()` reject with
`NotSupported`; `migrate(id)` answers `{ status: 'skipped' }` for a tenant without a schema.

```ts
const lifecycle = await DI.resolve(TenantLifecycle);
const acme = await lifecycle.provision({ id: 'acme', slug: 'acme', name: 'Acme Ltd', domains: ['acme.example'] }); // state 'active'
```

## Provisioning

The row is written in state `provisioning`, which `admitTenant` refuses. Then each `TenantSeeder` runs (step
`seed:<name>`, by `order`, then by name, inside `runInTenant(id)`), and last the step `activate` makes the tenant
`active`. Each finished step is written into the row's `lifecycle` column. A failed step leaves the tenant
`provisioning`, and its error reaches the caller (a seeder's error is wrapped in an `InvalidOperation` that names the
seeder). Calling `provision()` again **with the same input** continues with the next step; another slug or name is
refused (`InvalidArgument`), so is an active tenant (`ResourceDuplicated`), a suspended or deleted one
(`InvalidOperation`), and a slug or domain of another tenant (`ResourceDuplicated`).

A seeder that finished and was written down does not run again. One whose process died, or whose lease was taken
over, after it finished and before the step was written down runs again: write every seeder to be safe to repeat.

## One operation at a time

An operation holds a lease on the tenant's row (`lifecycle_owner`, `lifecycle_until`, `lifecycle_epoch`): a second
operation on the tenant is refused with `ConcurrencyConflict` until the first ends. The lease lasts 15 minutes
(`LIFECYCLE_LEASE_MS`) from its last renewal; `provision()` renews it after every step and every 5 minutes while a step
runs, so a process that died frees the tenant at most 15 minutes after its last step or renewal. Every write to the
tenant's lifecycle record, and every renewal, names the lease's owner and epoch in its condition: an operation whose
lease was taken over fails at its next such write instead of writing over the new holder, and it checks the tenant
again once it holds the lease.

The lease is measured in database time: `DbClock` of `@spinajs/durable` reads the clock of the `default` connection
when the operation starts and counts on from there, so the skew between the machines does not count, only how far a
machine's clock drifts while one operation runs.
