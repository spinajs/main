# Mutex backends

`Mutex` is the abstract service behind every `mutex_*` helper. The package ships no implementation: you register one, and it decides where locks live (database, memory, Redis), how owners are identified and whether locks expire.

Register `OrmMutex` from `@spinajs/orm-threading` for locks shared through a database, subclass it to change one method, or write your own `Mutex` subclass.

## How it works

1. A class is registered under the `Mutex` token: `DI.register(MyMutex).as(Mutex)`, or `@Injectable(Mutex)` on the class.
2. A `mutex_*` helper, or a service with `@Autoinject(Mutex)`, resolves `Mutex`.
3. `DI.resolve(Mutex)` picks the **last** class registered as `Mutex` and returns its singleton. A class with another lifetime decorator (`@NewInstance()`, `@PerChildInstance()`) follows that lifetime.
4. The helper calls the method of the same name and returns its promise.
5. Nothing registered: DI builds the abstract `Mutex` itself, and the call throws `TypeError: DI.resolve(...).<method> is not a function`.

## Configuration

`@spinajs/threading` reads no configuration. A backend adds its own keys: `OrmMutex` reads `threading.mutex.tenant`, `threading.mutex.ttl` and `threading.mutex.checkInterval`; see [Database mutex](../orm-threading/01-database-mutex.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Mutex` | `Mutex` abstract class; singleton per implementation class unless the class sets another lifetime; resolved by type on the root container on every `mutex_*` call, or injected with `@Autoinject(Mutex)` | none registered | `OrmMutex` (`@spinajs/orm-threading`); your subclass | Replace: `DI.register(MyMutex).as(Mutex)` or `@Injectable(Mutex)`. Extend: subclass `OrmMutex` and override any of the seven public methods, calling `super`. |

### The `Mutex` contract

Implement all seven abstract methods. The helpers pass arguments through unchanged, so callers depend on these results.

| Method | Must do |
| --- | --- |
| `acquire(options: MutexLockOptions): Promise<LockResult>` | Create the lock when missing. Return `Locked: true` when `options.Tenant` now holds it, including when it already held it; `Locked: false` when another tenant holds it. Return at once, never wait. With `options.ttl` above `0`, let the lock expire `ttl` ms later. |
| `renew(options: MutexLockOptions): Promise<boolean>` | When `options.Tenant` still holds the lock, move its expiry to now + `ttl` and return `true`; otherwise return `false`. Never take a lock. A backend without expiry only reports whether the tenant holds the lock. |
| `release(options: MutexLockOptions, deleteOnClose?: boolean): Promise<boolean>` | Unlock, or delete with `deleteOnClose`, only when `options.Tenant` owns the lock. Return `true` when something changed. |
| `create(options: MutexLockOptions): Promise<MutexLock>` | Return the lock, creating it unlocked when missing. Never lock it. |
| `delete(options: MutexLockOptions): Promise<boolean>` | Delete the lock when it is not locked. Return `true` when deleted. |
| `get(name: string): Promise<MutexLock \| null>` | Return the lock data, or `null` when missing. |
| `wait(name: string, timeout?: number): Promise<boolean>` | Resolve `true` once the lock is free, `false` after `timeout` ms. `0` or `undefined` waits forever. |

A missing `options.Tenant` or `options.ttl` is the backend's choice. `processIdentity()` gives one tenant per process; `OrmMutex` uses `threading.mutex.tenant`, or `processIdentity()` when that is empty, and `threading.mutex.ttl`.

### When to register

- Register before the first `mutex_*` call you want routed to the backend. Module scope of your bootstrap file works: the helpers resolve lazily.
- A later registration wins for every later helper call; an instance already injected with `@Autoinject` keeps the old backend.
- The helpers resolve on the root container. A `Mutex` registered only in a child container (`DI.child()`) is seen by services resolved from that child, **not** by the helpers.
- `OrmMutex` needs `Configuration` and `Orm` resolved before its first call, and `OrmMigrator` when the `default` connection has `Migration.OnStartup`; see [Custom mutex backends](../orm-threading/02-custom-mutex-backends.md#when-to-register).

### `Mutex`: a lease backend in memory

Write your own backend when locks belong to one process (a CLI tool, a single-instance worker, tests) or to a store `OrmMutex` does not cover. This one gives every lock a lease, so a crashed holder cannot block others forever, and wakes waiters on release instead of polling.

```ts sample
import { EventEmitter } from 'node:events';
import { Injectable } from '@spinajs/di';
import { DateTime } from 'luxon';
import { LockResult, Mutex, MutexLock, MutexLockOptions, mutex_acquire, mutex_release } from '@spinajs/threading';

@Injectable(Mutex)
export class LeaseMutex extends Mutex {
  protected leaseMs = 60_000;
  protected locks = new Map<string, MutexLock>();
  protected released = new EventEmitter();

  protected tenantOf(options: MutexLockOptions): string {
    return options.Tenant?.trim() || `pid-${process.pid}`;
  }

  protected isHeld(lock: MutexLock): boolean {
    return lock.Locked && DateTime.now().diff(lock.Updated_at).as('milliseconds') < this.leaseMs;
  }

  public async acquire(options: MutexLockOptions): Promise<LockResult> {
    const tenant = this.tenantOf(options);
    const lock = await this.create(options);

    if (this.isHeld(lock) && lock.Tenant !== tenant) {
      return { Locked: false, Mutex: { ...lock } };
    }

    lock.Locked = true;
    lock.Tenant = tenant;
    lock.Updated_at = DateTime.now();
    return { Locked: true, Mutex: { ...lock } };
  }

  public async renew(options: MutexLockOptions): Promise<boolean> {
    const lock = this.locks.get(options.Name);
    if (!lock || !this.isHeld(lock) || lock.Tenant !== this.tenantOf(options)) {
      return false;
    }

    lock.Updated_at = DateTime.now();
    return true;
  }

  public async release(options: MutexLockOptions, deleteOnClose?: boolean): Promise<boolean> {
    const lock = this.locks.get(options.Name);
    if (!lock || lock.Tenant !== this.tenantOf(options)) {
      return false;
    }

    if (deleteOnClose) {
      this.locks.delete(options.Name);
    } else {
      lock.Locked = false;
      lock.Updated_at = DateTime.now();
    }

    this.released.emit('release', options.Name);
    return true;
  }

  public async create(options: MutexLockOptions): Promise<MutexLock> {
    let lock = this.locks.get(options.Name);
    if (!lock) {
      const now = DateTime.now();
      lock = { Name: options.Name, Tenant: this.tenantOf(options), Locked: false, Created_at: now, Updated_at: now };
      this.locks.set(options.Name, lock);
    }
    return lock;
  }

  public async delete(options: MutexLockOptions): Promise<boolean> {
    const lock = this.locks.get(options.Name);
    if (!lock || this.isHeld(lock)) {
      return false;
    }
    return this.locks.delete(options.Name);
  }

  public async get(name: string): Promise<MutexLock | null> {
    const lock = this.locks.get(name);
    return lock ? { ...lock, Locked: this.isHeld(lock) } : null;
  }

  public wait(name: string, timeout = 0): Promise<boolean> {
    const lock = this.locks.get(name);
    if (!lock || !this.isHeld(lock)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const leaseLeft = this.leaseMs - DateTime.now().diff(lock.Updated_at).as('milliseconds');
      const onRelease = (released: string) => {
        if (released === name) {
          finish(true);
        }
      };
      const finish = (free: boolean) => {
        clearTimeout(timer);
        this.released.off('release', onRelease);
        resolve(free);
      };
      // The lease ends before the timeout: the lock is free by then.
      const timer = setTimeout(() => finish(timeout === 0 || timeout >= leaseLeft), timeout === 0 ? leaseLeft : Math.min(timeout, leaseLeft));
      this.released.on('release', onRelease);
    });
  }
}

export async function rotateLogs(rotate: () => Promise<void>): Promise<boolean> {
  const options = { Name: 'log-rotation', Tenant: 'rotator' };
  if (!(await mutex_acquire(options)).Locked) {
    return false;
  }

  try {
    await rotate();
    return true;
  } finally {
    await mutex_release(options);
  }
}

```

`@Injectable(Mutex)` registers the class as `Mutex` when its module is imported; import it from your bootstrap file before the first lock. `DI.register(LeaseMutex).as(Mutex)` does the same without the decorator.

### `OrmMutex`: extend one method

Subclass `OrmMutex` when the database is the right store but one behaviour must change. Override a public method and call `super` for the rest. `OrmMutex.acquire()` and `wait()` call `this.get()` and `this.create()`, so overriding those changes both.

This subclass reports contention, so you can alert when a job keeps finding its lock taken.

```ts sample
import { DI } from '@spinajs/di';
import { LockResult, Mutex, MutexLockOptions } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

export class ContentionAwareMutex extends OrmMutex {
  public readonly contention = new Map<string, number>();

  public async acquire(options: MutexLockOptions): Promise<LockResult> {
    const result = await super.acquire(options);

    if (result.Locked) {
      this.contention.delete(options.Name);
    } else {
      this.contention.set(options.Name, (this.contention.get(options.Name) ?? 0) + 1);
    }

    return result;
  }
}

DI.register(ContentionAwareMutex).as(Mutex);

export function locksBlockedAtLeast(times: number): string[] {
  const mutex = DI.resolve(Mutex) as ContentionAwareMutex;
  return [...mutex.contention].filter(([, count]) => count >= times).map(([name]) => name);
}
```

More `OrmMutex` subclasses (a custom default tenant) are in [Custom mutex backends](../orm-threading/02-custom-mutex-backends.md).

### Replace the backend in tests

The helpers resolve `Mutex` on each call, so a test registers a fake and the code under test picks it up. Register the real backend again, or clear the registration, after the test.

```ts sample
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';
import { LockResult, Mutex, MutexLock, MutexLockOptions, mutex_acquire } from '@spinajs/threading';

export class AlwaysBusyMutex extends Mutex {
  protected lock(name: string): MutexLock {
    const now = DateTime.now();
    return { Name: name, Tenant: 'someone-else', Locked: true, Created_at: now, Updated_at: now };
  }

  public async acquire(options: MutexLockOptions): Promise<LockResult> {
    return { Locked: false, Mutex: this.lock(options.Name) };
  }
  public async renew(): Promise<boolean> {
    return false;
  }
  public async release(): Promise<boolean> {
    return false;
  }
  public async create(options: MutexLockOptions): Promise<MutexLock> {
    return this.lock(options.Name);
  }
  public async delete(): Promise<boolean> {
    return false;
  }
  public async get(name: string): Promise<MutexLock | null> {
    return this.lock(name);
  }
  public async wait(): Promise<boolean> {
    return false;
  }
}

export async function importSkipsWhenLocked(runImport: () => Promise<'done' | 'skipped'>): Promise<boolean> {
  DI.register(AlwaysBusyMutex).as(Mutex);

  const blocked = await mutex_acquire({ Name: 'product-import', Tenant: 'test' });
  return blocked.Locked === false && (await runImport()) === 'skipped';
}
```

## Important behaviour

- Lock strength is the backend's: `OrmMutex.acquire()` is one conditional `UPDATE`, so of two processes racing for a lock only one gets `Locked: true`. See [Database mutex](../orm-threading/01-database-mutex.md#important-behaviour).
- `Mutex` has no lifetime decorator; DI treats a registered subclass as a singleton. Keep per-lock state in the instance (as `LeaseMutex` does), not in module globals.
- The contract declares expiry (`ttl`) and its heartbeat (`renew()`), but no fencing token: a holder whose lock expired keeps running until it notices that `renew()` returned `false`.
- `acquire()` is not re-entrant by count: a second acquire by the same tenant returns `Locked: true`, and one release frees the lock.

## Best practices

- Keep the seven contract results exact: `@Task()` in `@spinajs/tasks` skips a run only when `acquire()` returns `Locked: false`, and logs a warning when `renew()` returns `false`.
- Return copies of `MutexLock` from `acquire()` and `get()`, so callers cannot change your stored state.
- Default a missing `Tenant` to something unique per process, such as `processIdentity()`, not to a shared app name.
- Give an in-memory backend a lease when holders can crash or hang.

## Patterns and antipatterns

```ts
// Don't: register inside a request handler; the backend swaps for every caller in the process
app.get('/report', async () => {
  DI.register(LeaseMutex).as(Mutex);
});

// Do: register once, in the bootstrap module, before the first lock
DI.register(LeaseMutex).as(Mutex);
```

```ts
// Don't: wait inside acquire(); the helpers and @Task() expect an immediate answer
public async acquire(options: MutexLockOptions) {
  await this.wait(options.Name);
  // ...
}

// Do: return Locked: false at once and let the caller decide to wait with mutex_wait()
```

## Related

- [Named mutex](01-named-mutex.md): the helpers and types callers use.
- [Custom mutex backends](../orm-threading/02-custom-mutex-backends.md): `OrmMutex` subclasses and a plain in-memory backend.
- [Lifetimes](../di/04-lifetimes.md): singleton, new-instance and per-child lifetimes a backend can choose.
- [Task locking](../tasks/02-task-locking.md): how `@Task()` depends on the registered backend.
