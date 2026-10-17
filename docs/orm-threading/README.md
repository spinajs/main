# `@spinajs/orm-threading`

A database-backed implementation of the `Mutex` service from `@spinajs/threading`. `OrmMutex` keeps named locks in the `__mutex__` table, so processes that share a database can coordinate through it.

It does **not** register itself: register `OrmMutex` as `Mutex` before the first `mutex_*` call. Its locks have no expiry, and its `acquire()` is not atomic across processes; see [Database mutex](01-database-mutex.md#important-behaviour).

## Install

```sh
npm install @spinajs/orm-threading
```

## Features

| Feature | What it does |
| --- | --- |
| [Database mutex](01-database-mutex.md) | `OrmMutex`: acquire, release, wait for, create, delete and read named locks stored in the database |
| [Custom mutex backends](02-custom-mutex-backends.md) | The `Mutex` DI token: register `OrmMutex`, extend it (atomic acquire, per-process tenant) or replace it |
| [Mutex table and migration](03-mutex-table-and-migration.md) | The `__mutex__` model and table, the shipped migration, widening columns, reading and cleaning locks |

## Quick start

Register the backend once at startup, then lock with the helpers from `@spinajs/threading`. `Configuration` and `Orm` must be resolved first.

```ts sample
import { DI } from '@spinajs/di';
import { Mutex, mutex_acquire, mutex_release } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

DI.register(OrmMutex).as(Mutex);

export async function rebuildSearchIndex(rebuild: () => Promise<void>): Promise<boolean> {
  const lock = { Name: 'search-index-rebuild', Tenant: `indexer-${process.pid}` };

  const result = await mutex_acquire(lock);
  if (!result.Locked) {
    return false;
  }

  try {
    await rebuild();
  } finally {
    await mutex_release(lock);
  }

  return true;
}
```

## Related packages

- [`@spinajs/threading`](../threading/README.md): declares the abstract `Mutex`, the `MutexLock`, `MutexLockOptions` and `LockResult` types, and the `mutex_*` helpers.
- [`@spinajs/orm`](../orm/README.md): models, migrations and connections the `__mutex__` table runs on.
- [`@spinajs/configuration`](../configuration/README.md): supplies `app.name` and `threading.mutex.checkInterval`.
- [`@spinajs/di`](../di/README.md): the container `Mutex` is registered in and resolved from.
- `@spinajs/tasks`: its `@Task()` decorator locks each task through `mutex_acquire()` when `taskStacking` is off.
