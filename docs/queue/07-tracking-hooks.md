# Tracking hooks

A `QueueTrackingHook` wraps every query the queue runs against its own `queue_jobs` table: the consumer's row reads and writes and the retention purge. Use it when those queries need a context the job itself does not have, such as a privileged identity, a tenant filter turned off, or a retry policy.

## How it works

1. Each job-row operation calls `tracked(fn)`, where `fn` builds and runs the queries. Callers are:
   - `DefaultQueueService.consume()`: find the row, insert it, read it again after a failed insert, the `executing`, `success` and failure updates, and every progress write;
   - `DefaultJobRetentionService.purgeJobs()`: the select and the delete, as one `fn`.
2. `tracked()` resolves `Array.ofType(QueueTrackingHook)` from DI, on every call.
3. It nests the hooks: the first registered hook's `aroundTracking(next)` is outermost; the innermost `next` is `fn`.
4. With no hooks, `fn` runs as is.
5. The result of `fn`, or its error, passes back through every hook.

Message handlers (`execute()`, callbacks) are **not** wrapped; [message hooks](06-message-hooks.md) wrap those.

## API

| Export | Kind | Meaning |
| --- | --- | --- |
| `QueueTrackingHook` | abstract class | `aroundTracking<T>(next: () => Promise<T>): Promise<T>` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Tracking hook | `QueueTrackingHook`, a list resolved with `Array.ofType(QueueTrackingHook)` on every `tracked()` call; each hook is a singleton | none | `AuthzQueueTrackingHook` (`@spinajs/authz-queue`): runs the queries as `SYSTEM`, so a job running as an ordinary user can still update its own row | `@Injectable(QueueTrackingHook)` on your class, or `DI.register(MyHook).as(QueueTrackingHook)`. Remove one with `DI.unregister(TheirHook)` |

### Tracking hook: custom implementation

Call `next()` inside the context you set up and return its result: the queries are built inside `next`, so they see that context. Register the hook before the first job is consumed.

Here the app filters every query by the tenant held in an `AsyncLocalStorage`; the queue's own table is not tenant-scoped, so the hook turns the filter off for it.

```ts sample
import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@spinajs/di';
import { QueueTrackingHook } from '@spinajs/queue';

export interface DbScope {
  tenantId?: string;
  tenantFilter: boolean;
}

export const dbScope = new AsyncLocalStorage<DbScope>();

@Injectable(QueueTrackingHook)
export class UnscopedJobTableHook extends QueueTrackingHook {
  public aroundTracking<T>(next: () => Promise<T>): Promise<T> {
    return dbScope.run({ ...dbScope.getStore(), tenantFilter: false }, next);
  }
}
```

## Important behaviour

- **`next` may run more than one query.** The purge selects and deletes inside one `next`; the consumer runs one operation per `next`.
- **Hooks see no message.** `aroundTracking()` has no argument; read context from your own async storage.
- **A hook error fails the operation it wraps.** In the consumer that fails the delivery; a failed insert is followed by a re-read, also through the hooks.
- **`@NewInstance()` hooks are ignored**, as with every `Array.ofType` list.

## Best practices

- Keep the hook cheap: it runs on every progress write.
- Use it for the queue's table only; for application models, use your own scoping.

## Examples

### Retry job-row writes on a database deadlock

```ts sample
import { DI } from '@spinajs/di';
import { OrmException } from '@spinajs/orm';
import { QueueTrackingHook } from '@spinajs/queue';

const DEADLOCK_CODES = ['ER_LOCK_DEADLOCK', 'SQLITE_BUSY'];

// drivers wrap the database error in OrmException.inner
function driverCode(err: unknown): string {
  const inner = err instanceof OrmException ? err.inner : err;
  return (inner as { code?: string } | undefined)?.code ?? '';
}

export class DeadlockRetryHook extends QueueTrackingHook {
  protected Attempts = 3;

  public async aroundTracking<T>(next: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await next();
      } catch (err) {
        if (attempt >= this.Attempts || !DEADLOCK_CODES.includes(driverCode(err))) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }
}

DI.register(DeadlockRetryHook).as(QueueTrackingHook);
```

## Related

- [Job tracking](03-job-tracking.md): every query this hook wraps.
- [Job retention](08-job-retention.md): the purge also runs through the hooks.
- [Message hooks](06-message-hooks.md): the hook around message handlers.
