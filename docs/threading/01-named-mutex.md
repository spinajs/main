# Named mutex

Lock a named resource so only one owner works on it at a time, across processes that share a backend. Use it for scheduled jobs, imports and migrations that must not run twice in parallel.

The helpers are thin wrappers: each one resolves the registered `Mutex` and calls the method of the same name. Where the lock lives, and how strong it is, depends on that backend; see [Mutex backends](02-mutex-backends.md).

## How it works

1. You register a backend once at startup: `DI.register(OrmMutex).as(Mutex)`.
2. A helper, for example `mutex_acquire(options)`, calls `DI.resolve(Mutex)` on the root container.
3. DI returns the singleton of the last class registered as `Mutex`.
4. The helper returns the promise of the matching method: `acquire`, `renew`, `release`, `create`, `delete`, `get` or `wait`.
5. Without a registration, DI builds the abstract `Mutex` itself and the call throws `TypeError: DI.resolve(...).acquire is not a function`.

| Helper | Calls | Returns |
| --- | --- | --- |
| `mutex_acquire(options: MutexLockOptions)` | `Mutex.acquire` | `Promise<LockResult>`: `Locked: true` when `options.Tenant` holds the lock. Creates the lock when missing. Does **not** wait. With `options.ttl`, the lock expires `ttl` ms later unless renewed. |
| `mutex_renew(options: MutexLockOptions)` | `Mutex.renew` | `Promise<boolean>`: moves the expiry of a lock `options.Tenant` still holds to now + `ttl`; `false` when the lock was released or taken over. Never takes a lock. |
| `mutex_release(options: MutexLockOptions, deleteOnClose?: boolean)` | `Mutex.release` | `Promise<boolean>`: `true` when the lock was released, or deleted with `deleteOnClose`. |
| `mutex_wait(name: string, timeout?: number)` | `Mutex.wait` | `Promise<boolean>`: `true` once the lock is free, `false` after `timeout` ms. `0` or no timeout waits forever. |
| `mutex_create(options: MutexLockOptions)` | `Mutex.create` | `Promise<MutexLock>`: the lock, created unlocked when missing. |
| `mutex_delete(options: MutexLockOptions)` | `Mutex.delete` | `Promise<boolean>`: `true` when the lock was deleted. |
| `mutex_get(name: string)` | `Mutex.get` | `Promise<MutexLock \| null>`: the lock data, or `null` when missing. |

### Types

| Type | Fields |
| --- | --- |
| `MutexLockOptions` | `Name: string`; `Tenant?: string`, who locks; `ttl?: number`, lock lifetime in ms, `0` for never. The backend picks defaults when they are missing: `OrmMutex` uses `threading.mutex.tenant`, or `processIdentity()` when that is empty, and `threading.mutex.ttl`. |
| `MutexLock` | `Name: string`, `Tenant: string` (current or last owner), `Locked: boolean`, `LockedUntil?: number \| null` (epoch ms, `null` or missing for never), `Created_at: DateTime`, `Updated_at: DateTime` (Luxon). |
| `LockResult` | `Locked: boolean`, `true` when the lock is granted; `Mutex: MutexLock`, the lock data. |

### Process identity

`processIdentity()` returns `<host>:<pid>:<random>`, generated once per process and at most 32 characters (`MAX_PROCESS_IDENTITY_LENGTH`), the size of the `__mutex__.Tenant` column. The host is cut from the left when it is too long, so the distinguishing tail of a container or pod name survives. The random part keeps two containers that reuse one host name and pid apart. `createProcessIdentity(host?, pid?)` builds a new one without caching it.

```mermaid
sequenceDiagram
  participant App
  participant Helper as mutex_acquire
  participant DI
  participant Backend as Mutex (e.g. OrmMutex)
  App->>Helper: { Name, Tenant }
  Helper->>DI: resolve(Mutex)
  DI-->>Helper: last registered implementation
  Helper->>Backend: acquire(options)
  Backend-->>App: LockResult
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Mutex` | `Mutex` abstract class; singleton per implementation class; resolved by type on every helper call | none | `OrmMutex` from `@spinajs/orm-threading`; your own subclass | `DI.register(MyMutex).as(Mutex)`, or subclass `OrmMutex`. See [Mutex backends](02-mutex-backends.md). |

The helpers are plain functions, not services: replace the backend, not the helpers.

## Important behaviour

- `mutex_acquire()` never blocks. A held lock returns `Locked: false` at once; poll with `mutex_wait()` and acquire again.
- `mutex_wait()` and `mutex_acquire()` are separate calls. Another owner can take the lock between them, so always check `Locked`.
- The tenant is the identity of the owner. Two calls with the same `Tenant` both get `Locked: true`.
- With `OrmMutex`, a missing `Tenant` falls back to `processIdentity()`, so processes exclude each other but callers inside one process do not. Give concurrent callers in one process their own tenants, or use `criticalSection()`. See [Database mutex](../orm-threading/01-database-mutex.md#important-behaviour).
- Release passes the same `Name` and `Tenant` you acquired with. `OrmMutex` matches both, so a release with another tenant returns `false` and leaves the lock held.
- A lock taken without a `ttl` (and with `threading.mutex.ttl` at `0`) never expires: a process that dies while holding it leaves it locked until someone releases or deletes it. With a `ttl`, renew the lock while the work runs, or another owner takes it over once it expires.
- Each helper resolves `Mutex` again, so a backend registered later replaces the earlier one for every following call.

## Best practices

- Release in `finally`, with the same options object you acquired with.
- Leave `Tenant` out to lock per process; pass one only to tell callers inside one process apart.
- Pass a `ttl` and call `mutex_renew()` every `ttl / 3` from a timer while long work runs.
- Pass a `timeout` to `mutex_wait()` in request handlers; without one it waits forever.
- Inject the backend with `@Autoinject(Mutex)` in services you unit test; the test registers a fake `Mutex` (see [Mutex backends](02-mutex-backends.md#replace-the-backend-in-tests)).

## Patterns and antipatterns

```ts
// Don't: ignore the result; every caller runs the export
await mutex_acquire({ Name: 'invoice-export' });
await exportInvoices();

// Do: check the result, release in finally
const options = { Name: 'invoice-export', ttl: 60_000 };
const lock = await mutex_acquire(options);
if (lock.Locked) {
  try {
    await exportInvoices();
  } finally {
    await mutex_release(options);
  }
}
```

```ts
// Don't: wait() only reports that the lock was free at one moment
await mutex_wait('price-import');
await importPrices();

// Do: wait, then acquire and check
if (await mutex_wait('price-import', 30_000)) {
  const lock = await mutex_acquire(options);
  // ...
}
```

## Examples

### Run the nightly invoice export on one instance only

The default tenant is this process, so the instances exclude each other. The heartbeat keeps the lock while the export runs; a crashed instance frees it within a minute.

```ts sample
import { DI } from '@spinajs/di';
import { Mutex, MutexLockOptions, mutex_acquire, mutex_release, mutex_renew } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

DI.register(OrmMutex).as(Mutex);

const exportLock: MutexLockOptions = {
  Name: 'nightly-invoice-export',
  ttl: 60_000,
};

export async function runNightlyExport(exportInvoices: () => Promise<number>): Promise<number | null> {
  const result = await mutex_acquire(exportLock);
  if (!result.Locked) {
    return null;
  }

  const heartbeat = setInterval(() => void mutex_renew(exportLock), 20_000);
  try {
    return await exportInvoices();
  } finally {
    clearInterval(heartbeat);
    await mutex_release(exportLock);
  }
}
```

### Wait for a running import, then take the lock

```ts sample
import { mutex_acquire, mutex_release, mutex_wait } from '@spinajs/threading';

export async function rebuildCatalog(rebuild: () => Promise<void>): Promise<'done' | 'busy'> {
  const options = { Name: 'catalog', Tenant: `catalog-rebuild-${process.pid}` };

  for (let attempt = 0; attempt < 3; attempt++) {
    const free = await mutex_wait(options.Name, 60_000);
    if (!free) {
      return 'busy';
    }

    const lock = await mutex_acquire(options);
    if (lock.Locked) {
      try {
        await rebuild();
        return 'done';
      } finally {
        await mutex_release(options);
      }
    }
  }

  return 'busy';
}
```

### Show who holds a lock

```ts sample
import { mutex_get } from '@spinajs/threading';

export async function describeLock(name: string): Promise<string> {
  const lock = await mutex_get(name);
  if (!lock) {
    return `${name}: never created`;
  }

  return lock.Locked ? `${name}: held by ${lock.Tenant} since ${lock.Updated_at.toISO()}` : `${name}: free`;
}
```

### Inject the backend into a service

```ts sample
import { AsyncService, Autoinject, Injectable } from '@spinajs/di';
import { Mutex } from '@spinajs/threading';

@Injectable()
export class StockSync extends AsyncService {
  @Autoinject(Mutex)
  protected mutex: Mutex;

  public async sync(warehouse: string, pull: () => Promise<void>): Promise<boolean> {
    const options = { Name: `stock-sync-${warehouse}`, Tenant: `stock-sync-${process.pid}` };

    const lock = await this.mutex.acquire(options);
    if (!lock.Locked) {
      return false;
    }

    try {
      await pull();
      return true;
    } finally {
      await this.mutex.release(options, true);
    }
  }
}
```

`release(options, true)` deletes the lock row instead of unlocking it; use it for locks with a one-off name.

## Related

- [Mutex backends](02-mutex-backends.md): the `Mutex` contract, registration and custom backends.
- [Database mutex](../orm-threading/01-database-mutex.md): how `OrmMutex` implements each method, and its limits.
- [Task locking](../tasks/02-task-locking.md): `@Task()` uses `mutex_acquire()`, `mutex_renew()` and `mutex_release()`.
- [Critical section and rate limit](03-critical-section-and-rate-limit.md): in-process queuing that needs no backend.
