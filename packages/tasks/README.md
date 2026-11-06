# `@spinajs/tasks`

> **Deprecated.** A compatibility shim over [`@spinajs/scheduler`](../scheduler/README.md), removed in 5.0. Use `@Schedule` classes and `SchedulerService.runInline()`.

The `@Task()` method decorator runs each call as a `manual` scheduler run under the schedule lease, records it in `__scheduler_run` (and in the legacy `__tasks` / `__task_history` tables while `tasks.legacyHistory` is on), and emits `TaskSuccess` / `TaskFailed` queue events.

## Documentation

- [Package overview](../../docs/tasks/README.md)
- [Task decorator](../../docs/tasks/01-task-decorator.md)
- [Task locking](../../docs/tasks/02-task-locking.md)
- [Task events](../../docs/tasks/03-task-events.md)
- [Task tables and migration](../../docs/tasks/04-task-tables-and-migration.md)
