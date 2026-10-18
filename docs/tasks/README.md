# `@spinajs/tasks`

Bookkeeping for recurring background work. The `@Task()` method decorator wraps a method so that each call is logged, recorded in the `__tasks` table, optionally guarded by a named mutex, and reported as a `TaskSuccess` or `TaskFailed` queue event.

It does **not** schedule anything: a task runs only when your code calls the decorated method. It ships no CLI command and no worker. Read [Important behaviour](01-task-decorator.md#important-behaviour) for how failed, skipped and interrupted runs are reported.

## Install

```sh
npm install @spinajs/tasks
```

`@Task()` needs a resolved `Orm` with a `default` connection and a resolved `QueueService`. With `taskStacking: false`, the default, it also needs a `Mutex` registered in DI, for example `OrmMutex` from [`@spinajs/orm-threading`](../orm-threading/README.md).

## Features

| Feature | What it does |
| --- | --- |
| [Task decorator](01-task-decorator.md) | `@Task(name, description, opts)`: the wrapper around a method, its flow, return value, logging and failure handling, and how to schedule a task |
| [Task locking](02-task-locking.md) | `taskStacking` and the `Mutex` DI service: which backend guards overlapping runs, and how to plug in your own |
| [Task events](03-task-events.md) | `TaskSuccess` and `TaskFailed`: the shipped `queue.*` config, routing them to a real transport, and consuming them |
| [Task tables and migration](04-task-tables-and-migration.md) | `__task` and `__task_history` models, the `__tasks` and `__task_history` tables, the shipped migration and history retention |

## Quick start

Register a mutex backend, decorate a method, and call it from your own scheduler. `Configuration`, `Orm` and `QueueService` must be resolved first.

```ts sample
import { DI } from '@spinajs/di';
import { Mutex } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';
import { Task } from '@spinajs/tasks';

DI.register(OrmMutex).as(Mutex);

export class InvoiceTasks {
  @Task('send-invoice-reminders', 'Emails customers with invoices overdue by 7 days', { taskStacking: false })
  public async sendReminders(): Promise<{ sent: number }> {
    // query overdue invoices and send the emails here
    return { sent: 0 };
  }
}

const tasks = new InvoiceTasks();
setInterval(() => void tasks.sendReminders(), 60 * 60 * 1000);
```

## Related packages

- [`@spinajs/threading`](../threading/README.md): the abstract `Mutex` and the `mutex_acquire()` / `mutex_release()` helpers `@Task()` calls.
- [`@spinajs/orm-threading`](../orm-threading/README.md): `OrmMutex`, the database-backed `Mutex` most apps register.
- [`@spinajs/orm`](../orm/README.md): the models and the migration run on the `default` connection.
- [`@spinajs/queue`](../queue/README.md): `TaskSuccess` and `TaskFailed` are `QueueEvent`s sent through `QueueService`.
- [`@spinajs/log`](../log/README.md): `@Task()` logs through the `TASKS` logger.
- [`@spinajs/configuration`](../configuration/README.md): loads the package's `config/tasks.js` and merges it with your app config.
