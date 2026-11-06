---
"@spinajs/scheduler": minor
"@spinajs/tasks": minor
---

`@spinajs/tasks` is folded into `@spinajs/scheduler` and deprecated; 5.0 removes the package and its `__tasks` / `__task_history` tables.

`@Task(name, description, opts)` now registers a `manual` schedule named after the task. Calling the decorated method runs it inline through `SchedulerService.runInline` as a scheduler run (trigger `manual`, recorded in `__scheduler_run`) under the run lease and heartbeat instead of the `@spinajs/threading` mutex, and resolves as in 3.x: with the method's value, `{ error: true, message }` when the method throws, and `undefined` when another run holds the schedule lease (also with `runTask(..., { rethrow: true })`). A run that cannot start is logged as `Cannot start task` and rejects; an error carrying `crash: true` is rethrown with nothing emitted or recorded. `taskStacking: false` maps to `overlap: 'skip'`, `taskStacking: true` to `overlap: 'queue'` (calls run side by side). `TaskSuccess` and `TaskFailed` are still emitted. The new key `tasks.legacyHistory` (default `true`) keeps writing `__tasks` and `__task_history`; 5.0 flips it to `false`. `lockTtl` is ignored (the lease lives `scheduler.leaseTtl`). `@spinajs/tasks` no longer needs a `Mutex` registration or depends on `@spinajs/threading`; it depends on `@spinajs/scheduler`, whose migration must run on the `default` connection.

`@spinajs/scheduler` drops its optional peer on `@spinajs/tasks` and the dynamic import behind it. `loadTaskMethodLookup` and `TaskMethodsModule` are deprecated and only return the registered task methods.
