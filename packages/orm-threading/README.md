# `@spinajs/orm-threading`

Database-backed implementation of the `@spinajs/threading` `Mutex`.

```ts
import { DI } from '@spinajs/di';
import { Mutex, mutex_acquire, mutex_renew, mutex_release } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

DI.register(OrmMutex).as(Mutex);

const lock = await mutex_acquire({ Name: 'nightly-import', ttl: 60_000 });
if (lock.Locked) {
  const heartbeat = setInterval(() => mutex_renew({ Name: 'nightly-import', ttl: 60_000 }), 20_000);
  try {
    // work
  } finally {
    clearInterval(heartbeat);
    await mutex_release({ Name: 'nightly-import' });
  }
}
```

## Semantics

- **Holder (tenant).** Defaults to the identity of the current process,
  `${hostname}:${pid}:${random}` (at most 32 chars). Replicas therefore exclude each other.
  Pass `Tenant` to choose the holder yourself.
- **Re-entrant per tenant.** The holder may acquire again. This is not counted: one `release()`
  frees the lock. Concurrent callers inside one process share the default tenant and are not
  excluded from each other; give them distinct tenants, or use `criticalSection()`.
- **Atomic.** Acquire is one conditional `UPDATE`. It is granted iff it changed the row.
- **Expiry.** `ttl` (ms) sets `LockedUntil = now + ttl`. After that, another tenant may take
  the lock. `renew()` extends a lock you still hold and returns `false` when you lost it.
  `ttl: 0` never expires.
- **Clock.** "Now" is read from the database (SQLite, MySQL, Postgres), so replica clock skew
  does not matter. Other drivers use the app clock.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `threading.mutex.ttl` | `0` | Lock lifetime in ms when `ttl` is not passed. `0` = never expires. |
| `threading.mutex.tenant` | `''` | Fixed default tenant. Empty = per-process identity. Setting one value on all replicas restores the old shared tenant (replicas do **not** exclude each other). |
| `threading.mutex.checkInterval` | `500` | Poll interval of `wait()` in ms. |
