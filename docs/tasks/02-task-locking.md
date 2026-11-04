# Task locking

A `@Task()` call runs as a `manual` run of the task's schedule in `@spinajs/scheduler`, so it is guarded the way every scheduler run is: by the schedule lease and the run lease on the `__scheduler_schedule` and `__scheduler_run` rows. `@spinajs/tasks` no longer takes a `@spinajs/threading` mutex and needs no `Mutex` registration.

## How it works

`taskStacking` sets the `overlap` of the schedule the decorator registers:

| `taskStacking` | Schedule `overlap` | A call while another run of the task is active |
| --- | --- | --- |
| `false` (default) | `'skip'` | `runInline()` cannot take the schedule lease and throws `ScheduleOverlap`. The decorated method logs `Task ... is already running, skipped` at `warn` and resolves with `undefined`. No run row is written. |
| `true` | `'queue'` | The run takes no schedule lease (it is `Forced`), so calls run side by side, as before. |

A run takes the schedule lease in one conditional `UPDATE` on `__scheduler_schedule`, so the rule holds across every process that shares the database, and against runs the scheduler loop starts for the same schedule. While the method runs, the run heartbeat renews the run lease and the schedule lease every `scheduler.leaseTtl / 3`. When the run ends, the lease is released.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `scheduler.leaseTtl` | `60000` | How long a lease lives without a heartbeat. A crashed process frees the task at most this long after its last renewal. |
| `TaskOptions.lockTtl` | `60000` | Deprecated and ignored; kept so existing decorators compile. |

## Important behaviour

- **A skipped call resolves `undefined`, also with `rethrow`.** `runTask(decl, self, args, { lock: true, rethrow: true })` rethrows only the method's own error, as in 3.x. `ScheduleOverlap` (a `RunConflict`, HTTP 409) reaches only callers of `SchedulerService.runInline()`.
- **A lost lease aborts the run.** When the heartbeat cannot renew the lease (the database is unreachable for `leaseTtl`), the run's signal aborts and the call resolves with `{ error: true, message: 'Run aborted: lease-lost' }`. The method itself keeps running until it returns; pass `currentRunContext()?.signal` to the I/O it does if it must stop.
- **A crashed process frees the task when the schedule lease expires.** An app that only uses `@Task` runs no scheduler loop: the run row stays `running`, and the task is callable again `scheduler.leaseTtl` after the last heartbeat. A replica that runs the scheduler loop also ends the stale run then.
- **Config overrides apply.** A `scheduler.schedules` entry with the task's name can change `overlap`, `timeout` or `enabled` like for any schedule.

## Related

- [Task decorator](01-task-decorator.md): the full flow of a call.
- [Inline runs](../scheduler/README.md#inline-runs): `SchedulerService.runInline()`, which the decorator calls.
