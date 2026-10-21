# Task decorator

`@Task(name, description, opts)` turns a method into a tracked task. Each call is logged, marked as running in the `__tasks` table, optionally guarded by a mutex, and reported as a `TaskSuccess` or `TaskFailed` event. Use it on methods that run periodically or on demand and that you want to see in the database and on the queue.

`@Task()` does **not** schedule the method. Call it from a timer, a queue job, a CLI command or an HTTP action.

## How it works

At class definition, `Task(taskName, description, opts)`:

1. Trims `taskName` and `description` with `_check_arg(_trim(), _non_empty())`. An empty value throws `InvalidArgument` while the class is being defined.
2. Merges `opts` over `DEFAULT_TASK_OPTIONS`.
3. Records a `TaskDeclaration` for the method (see [Task declarations](#task-declarations)).
4. Replaces `descriptor.value` with a wrapper that calls `runTask(declaration, this, args, { lock: true, rethrow: false })`.

On every call of the decorated method, `runTask()`:

1. Resolves a logger with `DI.resolve('__log__', ['TASKS'])` and logs `Executing task ...` at `info`.
2. Calls `__task.getOrCreate(null, { Name, Description, State: 'stopped' })`. It finds the row by its unique `Name` column, or inserts it. An existing row keeps its stored `Description`. When the insert fails because another process inserted the same `Name` first, it reads that row instead.
3. When `taskStacking` is `false`, the default, takes the task lock: it skips the run when the task is already running in this process, calls `mutex_acquire({ Name: 'task-<name>', ttl: lockTtl })` from `@spinajs/threading`, and starts a heartbeat that renews the lock. When the lock is held elsewhere, it logs a warning and returns `undefined` without running the method. See [Task locking](02-task-locking.md).
4. Sets `State = 'running'` and `LastRunAt = DateTime.now()` and saves the row with `task.update()`. When that save fails, it releases the lock before rethrowing.
5. Calls the original method with the same `this` and arguments.
6. When the method throws, logs at `error` and sets the result to `{ error: true, message }`, where `message` is the error's `message`, or the thrown value as a string.
7. Emits `TaskSuccess` with `TaskName` (the trimmed name) and logs at `success`, or emits `TaskFailed` with `TaskName` and `Reason: message`. See [Task events](03-task-events.md). An emit that throws is logged as `Cannot emit ...` and does not change the result.
8. In a `finally` block, releases the lock taken in step 3 (stops the heartbeat, then `mutex_release()`), sets `State = 'stopped'` and inserts a `__task_history` row with `TaskId`, `Result` and `Duration` in milliseconds. Errors in this step are logged as `Cannot finalize task` and swallowed.
9. Returns the method's result, or the `{ error, message }` object from step 6.

An error in steps 2 to 4 is logged as `Cannot start task` and rethrown to the caller. That covers a missing `default` connection and a missing `Mutex` registration.

```mermaid
sequenceDiagram
  participant Caller
  participant Wrapper as @Task wrapper
  participant DB as __tasks / __task_history
  participant Mutex
  participant Method as original method
  participant Queue as QueueService
  Caller->>Wrapper: sendReminders()
  Wrapper->>DB: __task.getOrCreate(Name)
  Wrapper->>Mutex: mutex_acquire('task-<name>', ttl) (taskStacking: false)
  Mutex-->>Wrapper: Locked
  Wrapper->>Mutex: mutex_renew() every lockTtl / 3 while the method runs
  Wrapper->>DB: State = running, LastRunAt = now
  Wrapper->>Method: apply(this, args)
  Method-->>Wrapper: result or error
  Wrapper->>Queue: TaskSuccess.emit() or TaskFailed.emit()
  Wrapper->>Mutex: mutex_release()
  Wrapper->>DB: State = stopped, insert history row
  Wrapper-->>Caller: result or { error, message }
```

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Task(taskName, description, opts?)` | Method, instance or static | `taskName: string` (stored in `__tasks.Name`, up to 64 characters, unique), `description: string` (stored in `__tasks.Description`, up to 128 characters), `opts: Partial<TaskOptions>` | Wraps the method as described above. The wrapper returns a `Promise`. |

`opts` is optional; missing options take their value from `DEFAULT_TASK_OPTIONS`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `taskStacking` | `boolean` | `false` | `false`: take the `task-<name>` mutex before the run and skip the run when it is held. `true`: no mutex; runs can overlap. |
| `lockTtl` | `number` | `60000` | Lifetime of the task mutex in ms, renewed every `lockTtl / 3` while the task runs. `0`: the lock never expires. See [Task locking](02-task-locking.md#configuration). |

The options type is exported as `TaskOptions`, the defaults as `DEFAULT_TASK_OPTIONS`.

`@Task()` replaces the method's descriptor. Decorators listed above it in the source wrap the `@Task()` wrapper; decorators listed below it are wrapped by it.

### Task declarations

Every `@Task()` method is recorded as a `TaskDeclaration` when its class is defined: `name`, `description`, the merged `options`, the declaring class as `target` (the constructor itself for a static method), `isStatic`, `propertyKey` and the undecorated `method`. `getTaskDeclarations(name?)` returns the declarations of one task name, or all of them; `@spinajs/scheduler` uses them to schedule tasks by name.

`runTask(declaration, thisArg, args, { lock, rethrow })` runs a declaration with the same bookkeeping as the decorated method. `lock: false` skips the task mutex, its heartbeat and the in-process guard, for a caller that holds a lock of its own. `rethrow: true` rejects with the method's error after the history row is written, instead of resolving with `{ error: true, message }`.

## Configuration

`@Task()` reads no config key. The package ships `config/tasks.js`, which `@spinajs/configuration` merges into the app config at startup:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.routing.TaskFailed`, `queue.routing.TaskSuccess`, `queue.connections` | | `task-empty-queue` | | Where the task events go. See [Task events](03-task-events.md#configuration). |

The tables live on the `default` connection, which is `db.DefaultConnection`. See [Task tables and migration](04-task-tables-and-migration.md).

## Services and extension points

The wrapper resolves every service from the root container on each call, so a registration made at startup applies to every later run.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Lock backend | `Mutex` from `@spinajs/threading`, resolved by `mutex_acquire()` / `mutex_release()`; singleton | none registered | `OrmMutex` (`@spinajs/orm-threading`), your own `Mutex` | `DI.register(MyMutex).as(Mutex)` before the first task call. See [Task locking](02-task-locking.md). |
| Logger | `__log__` factory, resolved with the name `TASKS` on every call | the `@spinajs/log` logger | any logger registered as `__log__` | Route or silence it with a `logger.rules` entry for `TASKS`; replace the factory as in [Replacing the logger](../log/17-replacing-the-logger.md). |
| Event sink | `QueueService`, resolved by `TaskSuccess.emit()` / `TaskFailed.emit()` | `DefaultQueueService` | your `QueueService` | Route the events with `queue.routing`. See [Task events](03-task-events.md). |
| Task state | `__task`, `__task_history` models on `default` | shipped models | none | Read or extend the tables. See [Task tables and migration](04-task-tables-and-migration.md). |
| The task itself | the class that holds the decorated method; whatever lifetime you give it | none | any class | Put `@Task()` on a method of a DI service to use `@Autoinject` and `resolve()` / `dispose()` in it. See the example below. |

### Task host: a DI service that schedules its own tasks

`@Task()` works on any method, so the natural host is a DI service: it gets its dependencies injected, starts its timers in `resolve()`, and stops them in `dispose()`. Resolve it once at startup, after `Orm` (or `OrmMigrator`, when the `default` connection has `Migration.OnStartup`) and `QueueService`.

```ts sample
import { AsyncService, Autoinject, DI, Singleton } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Mutex } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';
import { Task } from '@spinajs/tasks';

@Singleton()
export class ReportTasks extends AsyncService {
  @Autoinject()
  protected Config: Configuration;

  protected timers: NodeJS.Timeout[] = [];

  @Task('rebuild-sales-report', 'Rebuilds the daily sales report table', { taskStacking: false })
  public async rebuildSalesReport(): Promise<{ rows: number }> {
    const day = new Date().toISOString().slice(0, 10);
    // aggregate the orders of `day` into the report table here
    return { rows: day.length };
  }

  @Task('purge-temp-uploads', 'Deletes uploads older than one day', { taskStacking: true })
  public async purgeTempUploads(): Promise<{ deleted: number }> {
    return { deleted: 0 };
  }

  public async resolve(): Promise<void> {
    const everyMs = this.Config.get<number>('reports.rebuildEveryMs', 15 * 60 * 1000);

    this.timers.push(setInterval(() => void this.rebuildSalesReport(), everyMs));
    this.timers.push(setInterval(() => void this.purgeTempUploads(), 60 * 60 * 1000));

    await super.resolve();
  }

  public async dispose(): Promise<void> {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }
}

DI.register(OrmMutex).as(Mutex);

export async function startReportTasks(): Promise<ReportTasks> {
  return DI.resolve(ReportTasks);
}
```

## Important behaviour

- **Errors of the method are not rethrown.** A failed run resolves with `{ error: true, message }`; it never rejects. Check the result if the caller must react.
- **A skipped run resolves with `undefined`.** When the mutex is held, nothing marks the call as skipped except the `warn` log line.
- **A failed event emit does not change the run.** When `TaskSuccess.emit()` or `TaskFailed.emit()` throws (a queue outage), the error is logged and the call resolves with the run's result as usual: a run whose side effects already happened must not look like a failure a caller would retry.
- **A run killed mid-way is not cleaned up.** When the process dies during the method, `State` stays `'running'` and no history row is written. The lock expires `lockTtl` after the last heartbeat; see [Task locking](02-task-locking.md#important-behaviour).
- **`Description` is written once.** Changing the text in `@Task()` does not update an existing row.
- **The name is trimmed everywhere.** The database row, the mutex name, the event `TaskName` and the log fields all use the trimmed `taskName`.
- **The return value is stored as JSON.** `__task_history.Result` is a `@Json()` column, so return a JSON-serializable value.
- The exported constant `TASK_COMMAND` (`'task:command'`) is not used by the package.

## Best practices

- Pass `opts` with an explicit `taskStacking`, so the locking choice is visible at the decorator.
- Set `lockTtl` for tasks whose runs may pause the event loop for long stretches, so the heartbeat cannot fall behind.
- Keep `taskName` short, stable and unique across the app: it is the `__tasks` key and the mutex name.
- Return a small summary object (`{ sent: 12 }`), not the full data set: it is what the history stores.
- Catch errors you can handle inside the method and return them in the result; the wrapper turns every other error into `{ error: true }`.
- Call tasks through `void task()` or `.catch()` in timers: setup errors (no `Orm`, no `Mutex`) reject the call.

## Patterns and antipatterns

```ts
// Don't: expects the task to reject on failure; the wrapper resolves with { error: true } instead
try {
  await tasks.syncRates();
} catch {
  alertOps();
}

// Do: inspect the result
const result = await tasks.syncRates();
if (result && result.error) {
  alertOps();
}
```

## Examples

### Run a task from a CLI command

A cron entry on one server calls `node app.js rates:sync`; the command runs the task once.

```ts sample
import { Autoinject } from '@spinajs/di';
import { CliCommand, Command } from '@spinajs/cli';
import { Task } from '@spinajs/tasks';

export class ExchangeRateTasks {
  @Task('sync-exchange-rates', 'Downloads ECB exchange rates', { taskStacking: true })
  public async syncRates(): Promise<{ currencies: number }> {
    // download and store the rates here
    return { currencies: 31 };
  }
}

@Command('rates:sync', 'Downloads the daily exchange rates')
export class SyncRatesCommand extends CliCommand {
  @Autoinject()
  protected Tasks: ExchangeRateTasks;

  public async execute(): Promise<void> {
    const result = await this.Tasks.syncRates();
    if (result && 'error' in result) {
      process.exitCode = 1;
    }
  }
}
```

### Quiet the task logger in production

`@Task()` logs every run at `info`. Keep only warnings and errors of the `TASKS` logger.

```js
// config/logger.js
module.exports = {
  logger: {
    rules: [
      { name: 'TASKS', level: 'warn', target: 'Console', final: true },
      { name: '*', level: 'info', target: 'Console' },
    ],
  },
};
```

## Related

- [Task locking](02-task-locking.md): what `taskStacking: false` and `lockTtl` do, and which `Mutex` to register.
- [Task events](03-task-events.md): `TaskSuccess` and `TaskFailed`.
- [Task tables and migration](04-task-tables-and-migration.md): the rows step 2, 4 and 8 write.
- [Configuration and rules](../log/02-configuration-and-rules.md): routing the `TASKS` logger.
- [Commands](../cli/02-commands.md): running a task from the CLI.
