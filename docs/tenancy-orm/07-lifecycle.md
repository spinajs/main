# Tenant lifecycle

The lifecycle of a tenant is written in the columns that the migration `Tenants_2026_12_01_00_00_00` adds to
`tenants`: `lifecycle` (the steps of the running operation), `suspension` and the lease of the operation. A row of
`TenantModel` reads the two records with `row.lifecycleRecord()` and `row.suspensionRecord()`; both refuse a record
they cannot read with `InvalidOperation` instead of taking it as empty.

```ts
const row = await TenantModel.where('id', 'acme').first();
const failed = row?.lifecycleRecord().operation?.failed; // { step, message, at } of a provisioning that stopped
```

## One operation at a time

An operation holds a lease on the tenant's row (`lifecycle_owner`, `lifecycle_until`, `lifecycle_epoch`): a second
operation on the tenant is refused with `ConcurrencyConflict` until the first ends. The lease lasts 15 minutes
(`LIFECYCLE_LEASE_MS`) from its last renewal, so a process that died frees the tenant after that time. Every write to
the tenant's lifecycle record, and every renewal, names the lease's owner and epoch in its condition: an operation
whose lease was taken over fails at its next such write instead of writing over the new holder.
