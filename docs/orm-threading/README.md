# `@spinajs/orm-threading`

A database-backed implementation of the `Mutex` service from `@spinajs/threading`. `OrmMutex` keeps named locks in the `__mutex__` table, so processes that share a database can coordinate through it.

It does **not** register itself: register `OrmMutex` as `Mutex` before the first `mutex_*` call. Acquire is one atomic `UPDATE`, the default owner is the current process, and a lock taken with a `ttl` expires on the database clock unless its holder renews it; see [Database mutex](01-database-mutex.md#important-behaviour).

## Install

```sh
npm install @spinajs/orm-threading
```

## Features

| Feature | What it does |
| --- | --- |
| [Database mutex](01-database-mutex.md) | `OrmMutex`: acquire, renew, release, wait for, create, delete and read named locks stored in the database, with optional expiry on the database clock |
| [Custom mutex backends](02-custom-mutex-backends.md) | The `Mutex` DI token: register `OrmMutex`, extend it (default tenant, clock) or replace it |
| [Mutex table and migration](03-mutex-table-and-migration.md) | The `__mutex__` model and table, the shipped migration, widening columns, reading and cleaning locks |

## Quick start

Register the backend once at startup, then lock with the helpers from `@spinajs/threading`. `Configuration` and `Orm` must be resolved first.

```ts sample
import { DI } from '@spinajs/di';
import { Mutex, mutex_acquire, mutex_release } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

DI.register(OrmMutex).as(Mutex);

export async function rebuildSearchIndex(rebuild: () => Promise<void>): Promise<boolean> {
  // No Tenant: the owner is this process. The lock frees itself 10 minutes after a crash.
  const lock = { Name: 'search-index-rebuild', ttl: 10 * 60 * 1000 };

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

- [`@spinajs/threading`](../threading/README.md): declares the abstract `Mutex`, the `MutexLock`, `MutexLockOptions` and `LockResult` types, the `mutex_*` helpers and `processIdentity()`, the default tenant.
- [`@spinajs/orm`](../orm/README.md): models, migrations and connections the `__mutex__` table runs on.
- [`@spinajs/configuration`](../configuration/README.md): supplies `threading.mutex.tenant`, `threading.mutex.ttl` and `threading.mutex.checkInterval`.
- [`@spinajs/di`](../di/README.md): the container `Mutex` is registered in and resolved from.
- [`@spinajs/tasks`](../tasks/README.md): its `@Task()` decorator locks each task through `mutex_acquire()` with a `ttl` and renews it while the task runs, when `taskStacking` is off.
