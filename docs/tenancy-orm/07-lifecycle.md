# Tenant lifecycle

The lifecycle of a tenant is written in the columns that the migration `Tenants_2026_12_01_00_00_00` adds to
`tenants`: `lifecycle` (the steps of the running operation, read with `lifecycleOf(row)`), `suspension` (read with
`suspensionOf(row)`) and the lease of the operation. Both readers refuse a record they cannot read with
`InvalidOperation` instead of taking it as empty.

## One operation at a time

An operation holds a lease on the tenant's row (`lifecycle_owner`, `lifecycle_until`, `lifecycle_epoch`): a second
operation on the tenant is refused with `ConcurrencyConflict` until the first ends. The lease lasts 15 minutes
(`LIFECYCLE_LEASE_MS`) from its last renewal, so a process that died frees the tenant after that time. Every write of
the operation names the lease's owner and epoch in its condition: an operation whose lease was taken over fails at its
next write instead of writing over the new holder.

The expiry is measured with the clock of the process that takes or renews the lease, not the database's: to a machine
whose clock runs `s` ahead, a lease looks expired `s` early. Keep the clocks of the machines synchronized.
