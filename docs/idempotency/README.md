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

`peek(scope, key)` reads a key without claiming it: `done` with the reply and the fingerprint, `running` with
`leaseUntil`, or `undefined` for a free or expired key. `@spinajs/http` uses it to replay a completed key before the
policies run.

`idempotencyPrincipal(principal)` builds the `principal` of a scope from a `@spinajs/principal` principal: its
`principalKey` when it is unrestricted, with its authority (`ceiling`, `onBehalfOf`, `delegation`,
`authn.impersonator`, `companions`) when it is restricted (`isRestrictedPrincipal()`), so a narrower credential of one
identity never shares stored replies with its full session. `@spinajs/http` and `@spinajs/http-socket` scope keys with it.

`isSharedScope(principal)` is true for a principal that shares its key space with other callers: none, an
unauthenticated one, or a share link (`type: 'link'`) without `companions`. `isRandomKey(key)` is true for a UUID of
version 4 or 7, which another caller of a shared scope can neither hit by chance nor guess. `@spinajs/http` refuses
any other key from a shared scope (the `sharedScope` option of `@Idempotent`).

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
or released for it, and the key frees itself when its lease ends. `isCrash(error)` is that check; a transport that
records outcomes itself (the `@spinajs/http-socket` idempotency stage, the `@spinajs/http` `IdempotencyMiddleware`) uses it too.

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
`DbTimeSource`, both with `{ replace: true }`, then `await clock.advance(ms)` to end a lease.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `idempotency.store` | `OrmIdempotencyStore` | class name of the store |
| `idempotency.lease` | `30s` | lease of a claim: a duration or a positive number of milliseconds |
| `idempotency.sweepBatch` | `500` | rows one sweep deletes at most |
| `idempotency.sweepEvery` | `5m` | interval of the builtin `idempotency.sweep` schedule of `@spinajs/idempotency-scheduler` |

The values are checked at boot: a lease that is neither a duration above zero (`500ms`, `30s`, `5m`, `2h`, `1d`) nor a
positive integer of milliseconds, a `sweepEvery` that is not such a duration, and a `sweepBatch` below 1 fail the
Configuration.

## Sweeping

Expired replies and claims whose lease ended stay in the table until a sweep deletes them. `IdempotencyService.sweep()`
deletes at most `idempotency.sweepBatch` rows and answers how many; call it until it answers 0.

`@spinajs/idempotency` itself sweeps nothing. Without a sweep, expired rows stay in `__idempotency` (the ORM store);
the memory store only evicts completed keys above its `maxEntries`.

With `@spinajs/scheduler`, install `@spinajs/idempotency-scheduler` and import it once in the app entry:

```ts
import '@spinajs/idempotency-scheduler';
```

It registers the builtin schedule `idempotency.sweep`, which runs every `idempotency.sweepEvery` (default `5m`) on the
leader. Each run sweeps batch after batch until one comes back empty, stores `{ swept, batches }` as its result and
logs one line. See [`@spinajs/idempotency-scheduler`](../idempotency-scheduler/README.md) for how to see its runs,
trigger it and switch it off.

Without that package, call `IdempotencyService.sweep()` from whatever timer the app already has, until it answers 0.
