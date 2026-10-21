# Task tables and migration

`@spinajs/tasks` keeps one row per task in `__tasks` and one row per finished run in `__task_history`, both on the `default` connection. The `__task` and `__task_history` models are exported, so you can query them for a status page, add columns with your own migration, or purge old history.

## How it works

1. Importing `@spinajs/tasks` registers the `__task` and `__task_history` models (`@Model`) and the `Task_2024_12_03_11_41_00` migration (`@Migration('default')`).
2. `OrmMigrator`'s boot pass (`DI.resolve(OrmMigrator)`) runs the migration on the connection named by `db.DefaultConnection` when that connection has `Migration.OnStartup: true`. Otherwise run it with the ORM CLI. `Orm.resolve()` alone applies nothing.
3. The migration creates `__tasks` and `__task_history`.
4. When the driver reports `supportedFeatures().events` (MySQL only), it also creates the database event `__task_delete_old_entries`, which deletes history rows older than 7 days once a day.
5. At run time the `@Task()` wrapper reads and writes the rows; see [Task decorator](01-task-decorator.md#how-it-works).

## Schema

### `__tasks`

Model `__task`, `@Connection('default')`.

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `INT`, primary key, auto-increment | Task id; `__task_history.TaskId` points here. |
| `Name` | `VARCHAR(64)`, unique, not null | The `taskName` passed to `@Task()`, trimmed. |
| `Description` | `VARCHAR(128)`, not null | The `description` passed to `@Task()` when the row was created. |
| `State` | `ENUM('running', 'stopped')`, nullable | `'stopped'` on insert, `'running'` while a run is in progress. |
| `LastRunAt` | `DATETIME`, nullable | Start time of the last run. Luxon `DateTime` on the model (`@DateTime()`). |

### `__task_history`

Model `__task_history`, `@Connection('default')`.

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `INT`, primary key, auto-increment | Row id. |
| `TaskId` | `INT`, not null | `__tasks.Id`. No foreign key. |
| `Result` | `TEXT`, nullable | The method's return value as JSON (`@Json()`), or `{ "error": true, "message": "..." }` for a failed run. |
| `CreatedAt` | `DATETIME`, not null, defaults to the current time | When the run finished (`@CreatedAt()`). |
| `Duration` | `INT`, defaults to `0` | Run time of the method and its event emit, in milliseconds. |

### Event `__task_delete_old_entries` (MySQL)

| Schedule | Statement |
| --- | --- |
| every 1 day | ``DELETE FROM `__task_history` WHERE `CreatedAt` < NOW() - INTERVAL 7 DAY`` |

The cutoff is computed by the engine on each run. The MySQL event scheduler must be on (`event_scheduler = ON`) for it to fire.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.DefaultConnection` | `string` | none | a connection `Name` | The connection stored as `default`; the models and the migration use it. See [Connections](../orm/01-connections.md#configuration). |
| `db.Connections[].Migration.OnStartup` | `boolean` | `false` | | Runs pending migrations, including this one, in `OrmMigrator`'s boot pass. See [Migrations](../orm/10-migrations.md#configuration). |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `__task`, `__task_history` | `@Model` registrations, collected into `Orm.Models` at `Orm.resolve()`; bound to `default` | shipped models | none | Query them with the static model API. Add columns with your own migration; the ORM reads table columns at boot, so extra columns appear in queries. See [Models](../orm/02-models.md). |
| `Task_2024_12_03_11_41_00` | `@Migration('default')`, registered on import | shipped migration | none | Add a later migration on `default` to change the tables. See [Migrations](../orm/10-migrations.md#ship-migrations-from-a-plugin-package). |
| History retention | MySQL event `__task_delete_old_entries` | 7 days, MySQL only | your own purge task | On other databases, or for another retention, schedule a purge as in [Purge history older than 30 days](#purge-history-older-than-30-days). |

### Migration: index history by task and record the host

`__task_history` has no index on `TaskId`, so reading one task's history scans the table. This migration adds the index and a `Host` column for your own writes. It runs on `default` after the shipped migration, because its class-name timestamp is later.

```ts sample
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('default')
export class TaskHistoryByTask_2026_10_17_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.index().table('__task_history').name('__task_history_task_id').columns(['TaskId']);

    await connection.schema().alterTable('__task_history', (table) => {
      table.string('Host', 64);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__task_history', (table) => {
      table.dropColumn('Host');
    });

    await connection.schema().raw('DROP INDEX __task_history_task_id');
  }
}
```

`DROP INDEX <name>` is the SQLite and PostgreSQL form; MySQL and MSSQL need `ON <table>`.

## Important behaviour

- **`State` is `'running'` only while a run is in progress.** Each finished run sets it back to `'stopped'`. A process killed mid-run leaves it `'running'` and writes no history row.
- **Rollback drops everything.** The migration's `down()` drops the MySQL event (when the driver supports events) and both tables, with their rows.
- **Older databases have an extra index.** A database migrated by an earlier version of this migration also has the unique index `__tasks_unique_name` on `Name`, redundant with the column's `UNIQUE`.
- **Retention is MySQL only.** On SQLite, PostgreSQL and MSSQL nothing deletes history rows.
- **The models are bound to `default`.** There is no config key to move them to another connection; the task tables live wherever `db.DefaultConnection` points.
- `__task_history.TaskId` is typed `Number` (the boxed type) on the model; compare it with `Number(row.TaskId)`.
- `Result` is a `@Json()` column: it is stored as JSON text and hydrated back into a value when you read the row.

## Best practices

- Run the migration once in every environment that runs tasks, even if you do not read the tables: the wrapper writes `__tasks` on every call and fails without it.
- Add an index on `__task_history.TaskId` before you show per-task history.
- Read `LastRunAt` from `__tasks` for "last started" and `__task_history.CreatedAt` for "last finished".

## Examples

### List the last runs of a task

```ts sample
import { __task, __task_history } from '@spinajs/tasks';

export async function lastRuns(taskName: string, count = 10) {
  const task = await __task.where({ Name: taskName }).first();
  if (!task) {
    return [];
  }

  const runs = await __task_history.where({ TaskId: task.Id }).orderByDescending('CreatedAt').take(count);

  return runs.map((run) => ({
    finishedAt: run.CreatedAt.toISO(),
    durationMs: run.Duration,
    failed: run.Result !== null && typeof run.Result === 'object' && run.Result.error === true,
  }));
}
```

### Purge history older than 30 days

Databases without engine events need a purge of their own. Make it a task, so its runs are tracked too.

```ts sample
import { DateTime } from 'luxon';
import { Task, __task_history } from '@spinajs/tasks';

export class TaskHousekeeping {
  @Task('purge-task-history', 'Deletes task history older than 30 days', { taskStacking: false })
  public async purgeHistory(): Promise<{ cutoff: string | null }> {
    const cutoff = DateTime.now().minus({ days: 30 });
    await __task_history.destroy().where('CreatedAt', '<', cutoff);
    return { cutoff: cutoff.toISO() };
  }
}
```

## Related

- [Task decorator](01-task-decorator.md): which step writes which column.
- [Migrations](../orm/10-migrations.md): how `@Migration` classes are discovered and run.
- [Schema builder](../orm/09-schema-builder.md): `alterTable`, indexes and database events.
- [Model API](../orm/03-model-api.md): `where`, `first`, `destroy` and the other static methods used above.
