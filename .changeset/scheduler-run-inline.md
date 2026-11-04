---
"@spinajs/scheduler": minor
---

`SchedulerService.runInline(schedule, fn, opts?)` is new: it runs `fn` in the calling process as a `manual` run of the schedule, under the run lease and heartbeat, never retries it automatically, and returns or rethrows its result. It takes the schedule lease and throws the new `ScheduleOverlap` (a `RunConflict`) when another run holds it; a `runOn: 'all'` schedule runs without it but at most once per replica at a time, and the schedule of a stacking `@Task` (as registered, whatever a config entry says) runs without it side by side. An error carrying `crash: true`, from `fn` or from the scheduler's own writes, leaves the run and its leases untouched and is rethrown; a crash inside `ctx.step()` no longer records the step as failed, in loop runs too. A schedule declared after boot is adopted on first use, and a pruned schedule row is inserted again.

`registerTaskMethod`, `findTaskMethods`, `isTaskMethodAdapter` and `isStackingTaskMethod` let `@spinajs/tasks` register its methods with the scheduler; a `@spinajs/tasks` that does not is still found through the optional import. A `@Schedule` with the same name as a registered `@Task` schedule wins over it with a warning instead of failing the boot, and a config entry built on a `@Task` schedule no longer inherits its `overlap`.
