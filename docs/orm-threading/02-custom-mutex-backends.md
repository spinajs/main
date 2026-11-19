# Custom mutex backends

Every lock goes through one DI token: the abstract `Mutex` class from `@spinajs/threading`. `OrmMutex` is one implementation of it. Extend `OrmMutex` to change one behaviour, such as how the default holder is chosen, or register your own `Mutex` subclass to keep locks somewhere else.

## How it works

1. A `mutex_*` helper (`mutex_acquire`, `mutex_renew`, `mutex_release`, `mutex_create`, `mutex_delete`, `mutex_get`, `mutex_wait`) calls `DI.resolve(Mutex)` on the root container.
2. The container returns the instance of the **last** class registered as `Mutex`. Without a registration it builds the abstract `Mutex` itself, and the call fails with `TypeError: ... is not a function`.
3. The instance is a singleton, cached under its concrete class name, unless the class carries another lifetime decorator.
4. The helper calls the matching method on it.

Classes that inject `Mutex` with `@Autoinject(Mutex)` take the same path.

`OrmMutex` calls its own methods through `this`: `acquire()` uses `this.tryLock()`, `this.get()` and `this.create()`, and `wait()` uses `this.get()`. Overriding `get()` or `create()` also changes `acquire()` and `wait()`. Every public method picks the name, holder and ttl through the protected `nameOf()`, `holderOf()` and `ttlOf()`, and reads the clock through `now()`; override those to change the defaults everywhere at once.

## Configuration

`OrmMutex` subclasses inherit `threading.mutex.holder` (as `this.ConfiguredHolder`), `threading.mutex.ttl` (as `this.DefaultTtl`) and `threading.mutex.checkInterval` (as `this.MutexWaitInterval`); see [Database mutex](01-database-mutex.md#configuration). Add your own keys with `@Config` on the subclass.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Mutex` | `Mutex` (abstract class, `@spinajs/threading`); singleton by default; resolved by type with `DI.resolve(Mutex)` on every helper call | none registered | `OrmMutex` (`@spinajs/orm-threading`); your subclass | Replace: `DI.register(MyMutex).as(Mutex)` before the first resolve. Extend: subclass `OrmMutex` and override any public method. |
| `OrmMutex` | not registered by the package; you register it as `Mutex` | `OrmMutex` | `PodHolderMutex` (example below) | Override `acquire`, `renew`, `release`, `create`, `delete`, `get` or `wait`, or the protected `tryLock`, `createIfMissing`, `isFree`, `now`, `nameOf`, `holderOf` and `ttlOf`. Protected config members: `ConfiguredHolder` (`threading.mutex.holder`), `DefaultTtl` (`threading.mutex.ttl`), `MutexWaitInterval` (`threading.mutex.checkInterval`). |

### `Mutex` contract

A replacement implements all seven abstract methods:

| Method | Must return |
| --- | --- |
| `acquire(options: MutexLockOptions): Promise<LockResult>` | `{ Locked: true, Mutex }` when `options.Holder` now holds the lock, `{ Locked: false, ... }` otherwise. Creates the lock when missing. Honours `options.ttl` when the backend supports expiry. |
| `renew(options: MutexLockOptions): Promise<boolean>` | `true` when `options.Holder` still holds the lock, after moving its expiry to now + `ttl`. Never takes a lock. |
| `release(options: MutexLockOptions, deleteOnClose?: boolean): Promise<boolean>` | `true` when the owner's lock was released (or deleted). |
| `create(options: MutexLockOptions): Promise<MutexLock>` | The lock, created unlocked when missing. |
| `delete(options: MutexLockOptions): Promise<boolean>` | `true` when the owner's lock was deleted. |
| `get(name: string): Promise<MutexLock \| null>` | The lock, or `null`/`undefined` when missing. |
| `wait(name: string, timeout?: number): Promise<boolean>` | `true` when the lock is free, `false` after `timeout` ms; `0` or no timeout waits forever. |

`MutexLock` has `Name`, `Holder`, `Locked`, an optional `LockedUntil` (epoch ms, `null` for never), `Created_at` and `Updated_at` (Luxon `DateTime`). `MutexLockOptions` has `Name`, an optional `Holder` and an optional `ttl` in ms.

### When to register

Register before anything resolves `Mutex`: before the first `mutex_*` call and before any service that injects it is built. A registration in your app's startup code, before the first lock is taken, is in time.

The last registration wins. Registering a subclass after `DI.register(OrmMutex).as(Mutex)` replaces it for every later resolve.

### `OrmMutex`: name the default holder after the pod

The stock default holder, `processIdentity()`, is unique per process but says little in a dashboard. This subclass uses the Kubernetes pod name when there is one, so `__mutex__.Holder` shows which pod holds a lock. Every public method picks the holder through `holderOf()`, so one override covers `acquire`, `renew`, `release`, `create` and `delete`.

```ts sample
import { DI } from '@spinajs/di';
import { Mutex, MutexLockOptions, mutex_acquire } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

export class PodHolderMutex extends OrmMutex {
  protected holderOf(options: MutexLockOptions): string {
    const pod = process.env.POD_NAME?.trim();

    // The Holder column is VARCHAR(32); the tail of a pod name is the distinguishing part.
    return options.Holder?.trim() || (pod ? pod.slice(-32) : super.holderOf(options));
  }
}

DI.register(PodHolderMutex).as(Mutex);

export async function tryLockMailQueue(): Promise<boolean> {
  const lock = await mutex_acquire({ Name: 'mail-queue-drain', ttl: 60_000 });
  return lock.Locked;
}
```

Two processes in one pod would share the holder and stop excluding each other; keep one app process per pod with this backend.

### `Mutex`: your own backend

Replace `OrmMutex` when the database is the wrong place for locks: in unit tests, or in a single-process tool. This in-memory backend keeps the same contract, including re-entrant acquire by the same holder. Its locks never expire, so `renew()` only reports whether the holder still holds the lock.

```ts sample
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';
import { LockResult, Mutex, MutexLock, MutexLockOptions, mutex_acquire, mutex_release } from '@spinajs/threading';

export class InMemoryMutex extends Mutex {
  protected locks = new Map<string, MutexLock>();

  protected holderOf(options: MutexLockOptions): string {
    return options.Holder?.trim() || 'local';
  }

  public async acquire(options: MutexLockOptions): Promise<LockResult> {
    const holder = this.holderOf(options);
    const lock = await this.create(options);

    if (lock.Locked && lock.Holder !== holder) {
      return { Locked: false, Mutex: lock };
    }

    lock.Locked = true;
    lock.Holder = holder;
    lock.Updated_at = DateTime.now();
    return { Locked: true, Mutex: { ...lock } };
  }

  public async renew(options: MutexLockOptions): Promise<boolean> {
    const lock = this.locks.get(options.Name);
    return !!lock && lock.Locked && lock.Holder === this.holderOf(options);
  }

  public async release(options: MutexLockOptions, deleteOnClose?: boolean): Promise<boolean> {
    const lock = this.locks.get(options.Name);
    if (!lock || lock.Holder !== this.holderOf(options)) {
      return false;
    }

    if (deleteOnClose) {
      this.locks.delete(options.Name);
    } else {
      lock.Locked = false;
      lock.Updated_at = DateTime.now();
    }
    return true;
  }

  public async create(options: MutexLockOptions): Promise<MutexLock> {
    let lock = this.locks.get(options.Name);
    if (!lock) {
      const now = DateTime.now();
      lock = { Name: options.Name, Holder: this.holderOf(options), Locked: false, Created_at: now, Updated_at: now };
      this.locks.set(options.Name, lock);
    }
    return lock;
  }

  public async delete(options: MutexLockOptions): Promise<boolean> {
    const lock = this.locks.get(options.Name);
    if (!lock || lock.Locked || lock.Holder !== this.holderOf(options)) {
      return false;
    }
    return this.locks.delete(options.Name);
  }

  public async get(name: string): Promise<MutexLock | null> {
    return this.locks.get(name) ?? null;
  }

  public wait(name: string, timeout = 0): Promise<boolean> {
    const start = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const lock = this.locks.get(name);
        if (!lock || !lock.Locked) {
          clearInterval(timer);
          resolve(true);
        } else if (timeout > 0 && Date.now() - start >= timeout) {
          clearInterval(timer);
          resolve(false);
        }
      }, 10);
    });
  }
}

DI.register(InMemoryMutex).as(Mutex);

export async function secondWorkerIsBlocked(): Promise<boolean> {
  await mutex_acquire({ Name: 'report-build', Holder: 'worker-1' });
  const second = await mutex_acquire({ Name: 'report-build', Holder: 'worker-2' });
  await mutex_release({ Name: 'report-build', Holder: 'worker-1' });

  return second.Locked === false;
}
```

Other backends, such as Redis, follow the same shape: implement the seven methods, register the class as `Mutex`.

## Important behaviour

- Nothing in the framework registers a `Mutex`. A `mutex_*` call without a registration fails at call time, not at startup.
- `DI.resolve(Mutex)` uses the root container. A `Mutex` registered only in a child container is not used by the `mutex_*` helpers.
- The singleton is cached under the concrete class name. Registering another class after the first resolve takes effect, because the new class has its own cache entry.
- `OrmMutex` has no constructor arguments and no `resolve()` hook; a subclass may add either.

## Best practices

- Extend `OrmMutex` when you keep the `__mutex__` table; implement `Mutex` directly only for another store.
- Change how the holder is chosen by overriding `holderOf()`, not `acquire()` alone, or the owner check in `renew()` and `release()` will not match.
- In tests, register an in-memory `Mutex` instead of booting an ORM connection for code that only needs locking.

## Patterns and antipatterns

```ts
// Don't: register after something already called mutex_acquire(); that call used whatever was registered then
await mutex_acquire({ Name: 'warmup', Holder: holder });
DI.register(PodHolderMutex).as(Mutex);

// Do: register in startup code, before the first lock
DI.register(PodHolderMutex).as(Mutex);
await mutex_acquire({ Name: 'warmup', Holder: holder });
```

## Migration

### `tenantOf()` is `holderOf()`, `ConfiguredTenant` is `ConfiguredHolder`

Both protected members of `OrmMutex` are renamed, with no alias. `OrmMutex` picks the holder through `holderOf()` only: a subclass method still named `tenantOf()` is never called.

```ts
// Before
export class PodHolderMutex extends OrmMutex {
  protected tenantOf(options: MutexLockOptions): string {
    return options.Tenant?.trim() || this.ConfiguredTenant || podName();
  }
}

// After
export class PodHolderMutex extends OrmMutex {
  protected holderOf(options: MutexLockOptions): string {
    return options.Holder?.trim() || this.ConfiguredHolder || podName();
  }
}
```

A `Mutex` backend of your own reads `options.Holder`; see [Mutex backends](../threading/02-mutex-backends.md#migration).

## Related

- [Database mutex](01-database-mutex.md): what each `OrmMutex` method does.
- [Mutex table and migration](03-mutex-table-and-migration.md): the model the subclasses above write through.
- [Registering services](../di/01-registering-services.md): `DI.register(...).as(...)` and which registration wins.
- [Lifetimes](../di/04-lifetimes.md): change the singleton default with a lifetime decorator.
- [Injecting config values](../configuration/07-injecting-config-values.md): `@Config` on a subclass.
- [`@spinajs/threading`](../threading/README.md): the abstract `Mutex` and the `mutex_*` helpers.
