# `@spinajs/tasks`

Bookkeeping for recurring background work: the `@Task()` method decorator logs each run, records it in the `__tasks` table, optionally guards it with a mutex, and emits `TaskSuccess` / `TaskFailed` queue events. It does not schedule tasks.

## Documentation

- [Package overview](../../docs/tasks/README.md)
- [Task decorator](../../docs/tasks/01-task-decorator.md)
- [Task locking](../../docs/tasks/02-task-locking.md)
- [Task events](../../docs/tasks/03-task-events.md)
- [Task tables and migration](../../docs/tasks/04-task-tables-and-migration.md)
