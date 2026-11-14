---
"@spinajs/scheduler": major
---

`@spinajs/tasks` is removed from the monorepo and is no longer published, with `@Task()`, `runTask`, `TaskSuccess`, `TaskFailed` and the `tasks.*` configuration. A `@Task` method becomes a `@Schedule` class (`manual: true` for one that only ran when called), and its callers call `SchedulerService.runInline()`; `ScheduleRunSucceeded` and `ScheduleRunFailed` replace the task events. The upgrade guide has the steps and the `DROP` statements for the `__tasks` and `__task_history` tables and the MySQL event `__task_delete_old_entries` that 3.x left behind.

`@spinajs/scheduler` drops its `@Task` support: `registerTaskMethod`, `findTaskMethods`, `isTaskMethodAdapter`, `isStackingTaskMethod`, `taskMethodSchedule`, `loadTaskMethodLookup` and the types `TaskMethodDeclaration`, `TaskMethodsModule`, `TaskMethodLookup` and `RunTaskFn` are removed, as are the `findTaskMethods` and `onShadowed` inputs of `buildDefinitions`. The `task` of a `scheduler.schedules` entry names a `@Schedule` class only, two schedules with one name always fail the boot, and concurrent `runInline` calls of one schedule never run side by side.
