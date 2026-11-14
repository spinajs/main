# `@spinajs/tasks`

> **Deprecated.** `@spinajs/tasks` is a compatibility shim over [`@spinajs/scheduler`](../../packages/scheduler/README.md) and is removed in 5.0, together with the `__tasks` and `__task_history` tables. New code uses `@Schedule` classes, and [`SchedulerService.runInline()`](../scheduler/README.md#inline-runs) for work the app starts itself.

The `@Task()` method decorator turns a method into a `manual` schedule named after the task. Each call of the method runs inline, in the caller's process, as a scheduler run: it is recorded in `__scheduler_run`, guarded by the schedule lease, and reported as a `TaskSuccess` or `TaskFailed` queue event. While `tasks.legacyHistory` is `true` (the 4.x default) the call is also recorded in `__tasks` and `__task_history`, as in 3.x.

The method still resolves with its own value, with `{ error: true, message }` when it throws, and with `undefined` when it was skipped because another run of the task was active. Read [Important behaviour](01-task-decorator.md#important-behaviour).

## Install

```sh
npm install @spinajs/tasks
```

`@Task()` needs a resolved `Orm` with a `default` connection that has the scheduler's migration applied, and a resolved `QueueService`. It no longer needs a `Mutex` registration.

## Features

| Feature | What it does |
| --- | --- |
| [Task decorator](01-task-decorator.md) | `@Task(name, description, opts)`: the wrapper around a method, its flow, return value, logging and failure handling, and how to schedule a task |
| [Task locking](02-task-locking.md) | `taskStacking` and the schedule lease: how overlapping runs are skipped and how a crashed run's lease expires |
| [Task events](03-task-events.md) | `TaskSuccess` and `TaskFailed`: the shipped `queue.*` config, routing them to a real transport, and consuming them |
| [Task tables and migration](04-task-tables-and-migration.md) | the legacy `__tasks` and `__task_history` tables, written while `tasks.legacyHistory` is on |

## Quick start

Decorate a method and call it, or name it in a `scheduler.schedules` entry to put it on a cron. `Configuration`, `Orm` and `QueueService` must be resolved first.

```ts sample
import { Task } from '@spinajs/tasks';

export class InvoiceTasks {
  @Task('send-invoice-reminders', 'Emails customers with invoices overdue by 7 days', { taskStacking: false })
  public async sendReminders(): Promise<{ sent: number }> {
    // query overdue invoices and send the emails here
    return { sent: 0 };
  }
}

export function sendRemindersNow(): Promise<{ sent: number }> {
  return new InvoiceTasks().sendReminders();
}
```

```js
// config/scheduler.js: run the task every night through the scheduler loop
module.exports = {
  scheduler: { schedules: [{ name: 'nightly-reminders', task: 'send-invoice-reminders', cron: '0 2 * * *' }] },
};
```

## Migrating to `@spinajs/scheduler`

| 3.x / 4.x `@spinajs/tasks` | `@spinajs/scheduler` |
| --- | --- |
| `@Task('name', 'desc')` on a method | `@Schedule('name', { manual: true })` on a `ScheduledTask` class |
| calling the decorated method | `SchedulerService.runInline('name', (ctx) => work(ctx))` |
| `taskStacking: false` / `true` | `overlap: 'skip'` / `'queue'` |
| `__tasks`, `__task_history` | `__scheduler_run` (`SchedulerService.listRuns({ schedule: 'name' })`) |

Set `tasks.legacyHistory: false` once nothing reads the legacy tables; 5.0 makes that the only behaviour.

## Related packages

- [`@spinajs/scheduler`](../../packages/scheduler/README.md): runs every task call and owns the run history.
- [`@spinajs/orm`](../orm/README.md): the models and the migrations run on the `default` connection.
- [`@spinajs/queue`](../queue/README.md): `TaskSuccess` and `TaskFailed` are `QueueEvent`s sent through `QueueService`.
- [`@spinajs/log`](../log/README.md): `@Task()` logs through the `TASKS` logger.
- [`@spinajs/configuration`](../configuration/README.md): loads the package's `config/tasks.js` and merges it with your app config.
