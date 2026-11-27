# Scheduled runs in a tenant

A scheduled run has no request, so its tenant comes from the schedule instance it belongs to: `__scheduler` holds one row per (`Name`, `Tenant`), `''` for the global instance, and each run row records the tenant of its instance (`NULL` for the global one). `import '@spinajs/tenancy/scheduler'` (needs `@spinajs/scheduler`) registers `TenantScheduleRunHook`, which runs every run of a tenant's instance inside that tenant.

```ts
// once, in every process that runs the scheduler loop
import '@spinajs/tenancy/scheduler';

@Schedule('close-day', { cron: '0 3 * * *' })
export class CloseDay extends ScheduledTask {
  public async execute(ctx: RunContext) {
    // ctx.tenant?.id and currentTenant()?.id name the tenant of the instance; undefined for the global one
    await Invoice.where({ status: 'open' }).update({ status: 'closed' });
  }
}
```

## How it works

`TenantScheduleRunHook` is a `ScheduleRunHook` of `@spinajs/scheduler` with `order` `TENANT_SCHEDULE_HOOK_ORDER` (`-100`), so hooks of other packages run inside the tenant. Around the body of every attempt, and around the emit of an emit-mode run:

1. The run of a tenant's instance: `admitTenant(id)` with no principal, then the body runs in `tenantScopeOf(record.id)`.
2. The run of the global instance: the body runs with no scope.
3. In both cases the request store starts empty: the scope, the principal and every other key of the code that drives or wakes the loop stay behind.

| The run's tenant when the attempt starts | Result |
| --- | --- |
| an active tenant | the body runs inside it; `ctx.tenant` and `currentTenant()` name it |
| none (the global instance) | the body runs with no scope; a tenant model throws `TenantRequired` |
| unknown to the registry | `TenantUnavailable` (`unknown`, `no such tenant`): the attempt fails and the body does not run |
| `provisioning`, `suspended`, `deleting` or `deleted` | `TenantUnavailable` (`inactive`, `tenant "<id>" is <state>`): the attempt fails and the body does not run |

A failed attempt follows the schedule's rules: it is retried under its `retry` policy (each attempt asks the registry again) and counts as a failure of the instance. A refused run fails once per occurrence and pauses its instance only when `pauseAfterFailures` is set: the operator sees a `run … ended failed` warn line and a `ScheduleRunFailed` event per occurrence and a growing `ConsecutiveFailures`, and fixes the tenant's state (or the import) or pauses the instance.

## Important behaviour

- **Admission happens at the start of each attempt.** A tenant suspended while a run is in progress does not stop that run: it ends inside its tenant. Its next attempt or run is refused.
- **No principal.** `admitTenant` gets none, so `TenantAccess.canEnter` is not asked, and the body runs as no principal (authz answers `UNATTENDED`). Which tenant a run enters is decided by the scheduler's own rows, not by a caller.
- **The scope covers the body**: its steps, the work it starts and does not await, its `catch` and `finally`, and the listeners it adds to `ctx.signal`, whoever aborts the run. The next run in the process starts from its own instance. The claim, the journal, the finalizers and the `ScheduleRun*` events run outside the scope, in the async context of whoever last woke the loop.
- **Every loop process imports the hook.** Without any `ScheduleRunHook` the scheduler refuses the runs of tenant instances (the attempt fails with `InvalidOperation`); with another package's hook but not this one, a tenant run executes in the async context of whoever last woke the loop: that request's tenant and principal.
- **Inline runs** (`SchedulerService.runInline`) are not wrapped: they keep the scope of their caller.

## Related

- [Tenant admission and access](04-admission-and-access.md): what `admitTenant` checks.
- [`@spinajs/scheduler`: run hooks and the tenant of a run](../scheduler/README.md#run-hooks-and-the-tenant-of-a-run).
