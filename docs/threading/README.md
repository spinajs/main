# `@spinajs/threading`

Coordination helpers for SpinaJS code: a named mutex behind a replaceable DI service, an in-process critical section and rate limit, and timer helpers.

It does **not** ship a mutex backend. `Mutex` is abstract: register an implementation, such as `OrmMutex` from [`@spinajs/orm-threading`](../orm-threading/README.md), before the first `mutex_*` call. It does **not** start worker threads or processes.

## Install

```sh
npm install @spinajs/threading
```

## Features

| Feature | What it does |
| --- | --- |
| [Named mutex](01-named-mutex.md) | `mutex_acquire`, `mutex_release`, `mutex_wait` and the other helpers: lock a named resource across processes through the registered `Mutex` |
| [Mutex backends](02-mutex-backends.md) | The `Mutex` DI token: its contract, how it is resolved, and how to register, replace or extend a backend |
| [Critical section and rate limit](03-critical-section-and-rate-limit.md) | `criticalSection` and `rateLimit`: queue callbacks by name inside one Node.js process |
| [Delay and sleep](04-delay-and-sleep.md) | `delay` runs a callback after a timeout and returns its result; `sleep` waits |

## Quick start

Register a backend once at startup, then lock with the helpers.

```ts sample
import { DI } from '@spinajs/di';
import { Mutex, mutex_acquire, mutex_release } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

DI.register(OrmMutex).as(Mutex);

export async function sendDailyDigest(send: () => Promise<void>): Promise<boolean> {
  const lock = { Name: 'daily-digest', Tenant: `mailer-${process.pid}` };

  const result = await mutex_acquire(lock);
  if (!result.Locked) {
    return false;
  }

  try {
    await send();
  } finally {
    await mutex_release(lock);
  }

  return true;
}
```

## Related packages

- [`@spinajs/orm-threading`](../orm-threading/README.md): `OrmMutex`, the database-backed `Mutex` implementation.
- [`@spinajs/tasks`](../tasks/README.md): `@Task()` locks each run with `mutex_acquire()`; see [Task locking](../tasks/02-task-locking.md).
- [`@spinajs/di`](../di/README.md): the container `Mutex`, the `__log__` factory and the critical section registry live in.
- [`@spinajs/log`](../log/README.md): registers the `__log__` factory that `criticalSection` needs.
