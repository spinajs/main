# Tenant lifecycle

The lifecycle of a tenant is written in the columns that the migration `Tenants_2026_12_01_00_00_00` adds to
`tenants`: `lifecycle` (the steps of the running operation), `suspension` and the lease of the operation. A row of
`TenantModel` reads the two records with `row.lifecycleRecord()` and `row.suspensionRecord()`; both refuse a record
they cannot read with `InvalidOperation` instead of taking it as empty.

```ts
const row = await TenantModel.where('id', 'acme').first();
const failed = row?.lifecycleRecord().operation?.failed; // { step, message, at } of a provisioning that stopped
```

`TenantLifecycle` creates, suspends and resumes tenants; importing `@spinajs/tenancy-orm` registers
`DefaultTenantLifecycle`. An operation names its tenant and runs outside a tenant scope (`TenantSwitchDenied` inside
one). This version provisions row-mode tenants only: a `placement` is refused, and `export()` and `delete()` reject
with `NotSupported`; `migrate(id)` answers `{ status: 'skipped' }` for a tenant without a schema.

```ts
const lifecycle = await DI.resolve(TenantLifecycle);
const acme = await lifecycle.provision({ id: 'acme', slug: 'acme', name: 'Acme Ltd', domains: ['acme.example'] }); // state 'active'
```

## Provisioning

The row is written in state `provisioning`, which `admitTenant` refuses. Then each `TenantSeeder` runs (step
`seed:<name>`, by `order`, then by name, inside `runInTenant(id)`), and last the step `activate` makes the tenant
`active`. Each finished step is written into the row's `lifecycle` column. A failed step leaves the tenant
`provisioning`, and its error reaches the caller (a seeder's error is wrapped in an `InvalidOperation` that names the
seeder). Calling `provision()` again **with the same input** continues with the next step; another slug, name,
domains or settings is refused (`InvalidArgument`), so is an active tenant (`ResourceDuplicated`), a suspended or
deleted one (`InvalidOperation`), and a slug or domain of another tenant (`ResourceDuplicated`). Two seeders with one
`name` are refused before the row is written (`InvalidOperation`).

A domain is checked before the row is written, so two tenants provisioned at the same moment can both list it. The
registry then refuses that domain for both (`InvalidOperation`) until an operator removes it from one of the rows.

A seeder that finished and was written down does not run again. One whose process died, or whose lease was taken
over, after it finished and before the step was written down runs again. The writes a seeder makes through its own
models are not fenced by the lease: a seeder whose operation lost the lease runs to its end, and the operation that
took over may run the same seeder meanwhile. Write every seeder to be safe to repeat and to run twice at once (an
upsert on a key, not a plain insert).

## Suspending and resuming

```ts
await lifecycle.suspend('acme', 'unpaid invoice 2026-11'); // 'suspended'; row.suspensionRecord() is { reason, at }
await lifecycle.resume('acme'); // 'active'; the suspension record is gone
```

`suspend(id, reason)` moves an `active` tenant to `suspended` and writes the reason and the time (database time) into
the row's `suspension` column; `resume(id)` moves a `suspended` tenant back to `active` and clears the column. Each is
one statement whose condition is the state it moves from (`active` for a suspension, `suspended` for a resume), so a
state and its reason are written together and of two calls at once only one changes the row. The model member that
writes it, `row.writeSuspension(to, suspension)`, makes only these two moves: for a tenant in any other state it changes
nothing and answers `false`, whatever state the row was read in. Neither call takes the lease: a suspension does not
wait for a running operation and never writes the `lifecycle` record that operation holds.

Refused, with the row left as it was:

- an empty reason (`InvalidArgument`);
- a tenant that is already suspended, also by a call a moment earlier (`InvalidOperation` "is already suspended"; the
  first reason stays);
- a `provisioning`, `deleting` or `deleted` tenant (`InvalidOperation` "cannot go from ... to suspended"). A running
  provisioning is not interrupted; its tenant is refused traffic until it is active anyway;
- a resume of a tenant that is not `suspended`, a `deleting` one included, and of a suspended tenant whose lifecycle
  record names a deletion (`InvalidOperation`): a deletion that started is finished, never undone by a resume. The
  record is read before the statement, so a deletion that records itself while the resume runs is not seen by it and
  the resume is done. Such a deletion is refused by the state instead: its first step, before it removes anything, is
  the move from `suspended` to `deleting` (`delete()` is not built in this version);
- a concurrent suspend and resume that moved the tenant between the read and the statement (`ConcurrencyConflict`
  "tenant ... changed while it was moved to ...; try again"): the row is as the other call left it. Nothing was
  written, so calling again is safe; the next call is done or refused by the state it then finds.

The reads before the statement only choose the message; the statement's condition decides. Once read replicas serve
reads, those reads must still go to the primary, or a call is refused as a conflict instead of by its reason.

### Who is refused, and when

- The process that suspended the tenant refuses every new request, job and socket handshake of it once `suspend()`
  returned: the call forgets the tenant in this process's registry cache.
- Every other process refuses them when its own cache entry of the tenant expires, at most `tenancy.registryCacheMs`
  (5000 ms by default) after `suspend()` returned. Until then it still admits new requests, jobs and socket handshakes
  of the tenant. Lower the setting where that window matters more than the reads the cache saves.

A suspension is checked only where work enters the tenant through the HTTP middleware, the socket handshake or the
queue consumer. It does not stop:

- **A WebSocket connection opened before the suspension.** It is not checked again: its messages run in the tenant, in
  every process, until the connection closes (until the socket branch of `@spinajs/tenancy-http` ends such
  connections). Unbounded. Today an application that suspends tenants with live sockets closes those connections
  itself, in every process.
- **Code that enters a tenant with `runInTenant` itself** (a scheduled task, a workflow step, your own code), and
  `forEachTenant` with a `states` list that includes `suspended`: never refused by a suspension. Such code checks the
  state itself before it enters the tenant (`admitTenant(id)` refuses a suspended tenant). `forEachTenant` with its
  default states skips the tenant from its next iteration on; a visit already started runs to its end.
- **A queue job already running.** It has no time limit: unbounded. A long job checks the state itself between its
  steps (`admitTenant(id)`) and stops when it is refused.
- **An HTTP request already admitted**, a stream (server-sent events, a long download) included: it runs to its end,
  bounded only by the server's request timeouts.

Nothing checks the state again while admitted work runs, so what it writes stays.

A process that dies after the statement and before it forgot the tenant leaves it suspended with its reason; the other
processes' cache entries expire as above. Calling `suspend()` again is refused as "already suspended" and forgets the
tenant in the calling process first.

## One operation at a time

An operation holds a lease on the tenant's row (`lifecycle_owner`, `lifecycle_until`, `lifecycle_epoch`): a second
operation on the tenant is refused with `ConcurrencyConflict` until the first ends. `suspend()` and `resume()` take no
lease (above). The lease lasts 15 minutes
(`LIFECYCLE_LEASE_MS`) from its last renewal; `provision()` renews it after every step and every 5 minutes while a step
runs, so a process that died frees the tenant at most 15 minutes after its last step or renewal. Every write to the
tenant's lifecycle record, and every renewal, names the lease's owner and epoch in its condition: an operation whose
lease was taken over fails at its next such write instead of writing over the new holder, and it checks the tenant
again once it holds the lease. Two writes are not fenced: those of the seeders (above) and the activation, a
compare-and-set of the state from `provisioning` to `active`.

The lease is measured in database time: `DbClock` of `@spinajs/durable` reads the clock of the `default` connection
when the operation starts and counts on from there, so the skew between the machines does not count, only how far a
machine's clock drifts while one operation runs.
