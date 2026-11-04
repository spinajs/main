# @spinajs/idempotency

A call runs at most once per key while its reply is kept. A repeat gets the stored reply, a concurrent repeat is told to
retry, and a repeat with a different request is refused. HTTP `@Idempotent()` routes, idempotent socket commands and
queue event consumers are meant to share this one service; this release ships the service itself.

## Guarantees

- The function runs **at least once**. A replica that dies after claiming a key and before storing the reply leaves the
  key claimed until its lease ends. Then the next repeat runs the function again. Make the side effect itself
  idempotent, or keep it in one transaction with the work it guards, if "once" must hold across a crash.
- While the reply is kept (`ttl`), a repeat with the same key replays it and never runs the function.
- A key whose function failed, or whose reply is not stored (`toReply` answered `undefined`), is released, so a repeat runs again.
- A key whose function threw `IdempotencyOutcomeUnknown` (the caller cannot tell whether the side effect happened, for
  example because the client went away) is kept until its lease ends, like the key of a replica that died.

## Running a call

```ts
import { IdempotencyService, fingerprintOf } from '@spinajs/idempotency';

const outcome = await idempotency.run(
  { namespace: 'billing:charge', principal: 'user:42' },
  request.idempotencyKey,
  async (signal) => charge(request, signal),
  {
    fingerprint: fingerprintOf(JSON.stringify(request)),
    ttl: '24h',
    toReply: (receipt) => ({ kind: 'receipt', body: receipt }),
    fromReply: (reply) => reply.body as Receipt,
  },
);
// outcome = { replayed: false, value } the first time, { replayed: true, value } on a repeat
```

- `IdempotencyInFlight` (with `retryAfterMs`) means another call holds the key now.
- `IdempotencyKeyReuse` means the key was used with a different fingerprint.
- `IdempotencyClaimConflict` (`retryable: true`) means a claim made inside a transaction lost a deadlock or a
  serialization check. The database rolled the surrounding transaction back: retry that whole transaction, and answer
  a client with a retryable reply (HTTP 409 with `Retry-After`), never a 500.
- `signal` aborts with `IdempotencyLeaseLost` once the lease could not be renewed. Another replica may then run the
  same key, so stop early.

`acquire(scope, key, { fingerprint, lease })` is the lower-level half of `run`: it answers `done` with the reply,
`running` with `retryAfterMs`, or `claimed` with an `IdempotencyHandle` that the caller completes, releases or
abandons itself. Use it when the claim and the settle happen in different places, as in a pipeline.

## Transactions

Run `IdempotencyService.run` outside business transactions. A claim made inside a transaction joins it: it commits or
rolls back with the transaction, and other callers of the same key wait on the row until then instead of being told
to retry at once. Claim inside a transaction only when the claim should roll back with the work it guards, and be
ready for `IdempotencyClaimConflict`.

## Keys and fingerprints

The stored key is the sha256 hex of the JSON text `[namespace, principal ?? null, key]`. The namespace and the principal
keep callers apart: the same client key from two users is two keys. A fingerprint (the sha256 of the request,
`fingerprintOf()`) makes a repeat with a different request fail with `IdempotencyKeyReuse`, also while the first call
still runs.

## Leases

A claim is a lease of `idempotency.lease` (default `30s`), renewed every third of it while the call runs. Every write
of a claim checks its token, so a replica that lost its lease can never store a reply over the new holder's. An error
that carries `crash: true` (a simulated dead process) stops the renewal and is rethrown by `run`; nothing is written
or released for it, and the key frees itself when its lease ends.

## Stores

| Store | Use |
|---|---|
| `OrmIdempotencyStore` (default) | `__idempotency` on the `idempotency` connection (`db.Aliases.idempotency`, default `default`). Shared by every replica. |
| `MemoryIdempotencyStore` | One process: tests, single-instance apps. Caps completed keys at `maxEntries` (100 000). |

With `OrmIdempotencyStore`, import the package in the app entry before the boot:

```ts
import '@spinajs/idempotency';
```

The ORM reads its models and runs migrations when it resolves. A later import (a lazy `import()`, a CLI command)
leaves `__idempotency` without a model and a migration. `ormModelRegistered(container)` tells whether the Orm resolved
with the model. An app without a database sets `idempotency.store: 'MemoryIdempotencyStore'`.

All lease and expiry times are database time (`DbClock`). The service syncs the clock when it resolves and before every
sweep, when its store is `OrmIdempotencyStore`.

A custom store extends `IdempotencyStore` and must pass the conformance suite:

```ts
import { describeIdempotencyStoreConformance } from '@spinajs/idempotency/testing';

describeIdempotencyStoreConformance('RedisIdempotencyStore', async () => new RedisIdempotencyStore(await freshRedis()));
```

In tests, drive leases with `FakeClock` from `@spinajs/durable/testing`: register it as `Clock` and its `dbSource` as
`DbTimeSource`, then `await clock.advance(ms)` to end a lease.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `idempotency.store` | `OrmIdempotencyStore` | class name of the store |
| `idempotency.lease` | `30s` | lease of a claim |
| `idempotency.sweepBatch` | `500` | rows one sweep deletes at most |
| `idempotency.sweepEvery` | `5m` | the interval an app's sweep schedule is meant to run at (see Sweeping) |

The values are checked at boot: a lease or `sweepEvery` that is not a duration (`500ms`, `30s`, `5m`, `2h`, `1d`) and a
`sweepBatch` below 1 fail the Configuration.

## Sweeping

Expired replies and claims whose lease ended stay in the table until a sweep deletes them. `IdempotencyService.sweep()`
deletes at most `idempotency.sweepBatch` rows and answers how many; call it until it answers 0. The package registers
no schedule of its own yet, so an app that runs `@spinajs/scheduler` declares one:

```ts sample
import { Autoinject } from '@spinajs/di';
import { IdempotencyService } from '@spinajs/idempotency';
import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';

@Schedule('app.idempotency-sweep', { every: '5m', runOn: 'leader', overlap: 'skip' })
export class IdempotencySweep extends ScheduledTask {
  @Autoinject(IdempotencyService)
  protected Idempotency: IdempotencyService;

  public async execute(ctx: RunContext): Promise<{ swept: number }> {
    let swept = 0;
    while (!ctx.signal.aborted) {
      const batch = await this.Idempotency.sweep();
      swept += batch;
      if (batch === 0) break;
    }
    ctx.result({ swept });
    return { swept };
  }
}
```

`runOn: 'leader'` keeps the replicas from sweeping the same rows at once. Without the scheduler, call
`IdempotencyService.sweep()` from whatever timer the app already has.
