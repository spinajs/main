---
"@spinajs/scheduler": minor
---

`SchedulerService.runInline(schedule, fn, opts?)` is new: it runs `fn` in the calling process as a `manual` run of the schedule, under the run lease and heartbeat, never retries it automatically, and returns or rethrows its result. It takes the schedule lease and throws the new `ScheduleOverlap` (a `RunConflict`) when another run holds it; only `runOn: 'all'` schedules and the schedule of a stacking `@Task` run without the lease. An error carrying `crash: true` leaves the run and its leases untouched and is rethrown. A schedule declared after boot is adopted on first use, and a pruned schedule row is inserted again.

`registerTaskMethod`, `findTaskMethods` and `isTaskMethodAdapter` let `@spinajs/tasks` register its methods with the scheduler; a `@spinajs/tasks` that does not is still found through the optional import. A `@Schedule` with the same name as a registered `@Task` schedule wins over it with a warning instead of failing the boot, and a config entry built on a `@Task` schedule no longer inherits its `overlap`.
