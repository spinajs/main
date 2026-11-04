# `@spinajs/durable`

The durability kernel shared by the scheduler and, later, workflows and the queue outbox relay: a clock seam, database time, durations, retry backoff, a lease heartbeat, step replay, a fenced row lease and named fault points. It holds no tables and starts no timers of its own.

## Install

```sh
npm install @spinajs/durable
```

## What it provides

| Export | What it does |
| --- | --- |
| `Clock`, `DurableSystemClock` | Time and timers behind DI. `DurableSystemClock` is the registered default and uses the host's timers. |
| `DbTimeSource`, `SqlDbTimeSource`, `DbClock` | `DbClock.sync()` reads the database time once and keeps the offset; `now()` is local time plus that offset. `SqlDbTimeSource` reads the `default` connection (SQLite, MySQL, Postgres). |
| `parseDuration` | `500ms`, `10s`, `5m`, `2h`, `30d`, `1w` or a number of milliseconds. |
| `computeBackoff`, `isRetryable`, `NonRetryableError`, `RetryPolicyOptions`, `NormalizedRetry` | Fixed or exponential backoff with ±10 % jitter capped at `maxDelayMs`; `NonRetryableError` is never retried, whatever `retryOn` says. |
| `Heartbeat` | One timer that renews a lease and flushes progress, and reports the lease lost after `leaseTtlMs` without a successful renewal. |
| `buildReplayMap`, `JournalRecord` | Recorded results by key from a journal, optionally cut from a key on (resume from a step). |
| `RowLease` | A lease on one table row, fenced by an epoch (see below). |
| `FaultInjector`, `NoFaults`, `FaultPointName` | Named points where production code lets the simulation harness inject a fault. `NoFaults` is the registered default and does nothing. |

The `@spinajs/durable/testing` subpath ships `FakeClock` (on `@sinonjs/fake-timers`, without touching the global timers) and `FakeDbTimeSource`, which reports the fake time plus `clock.dbSkewMs`.

```ts sample
import { DI } from '@spinajs/di';
import { Clock, DbClock, DbTimeSource } from '@spinajs/durable';
import { FakeClock } from '@spinajs/durable/testing';

export async function skewedDbClock(): Promise<number> {
  const clock = new FakeClock('2026-01-05T10:00:00Z');
  clock.dbSkewMs = 45_000;
  DI.register(() => clock).as(Clock);
  DI.register(() => clock.dbSource).as(DbTimeSource);

  const dbClock = DI.resolve(DbClock);
  await dbClock.sync();
  await clock.advance(1000);
  return dbClock.now() - clock.now(); // 45000
}
```

## `RowLease`

A row is claimable when its owner column is `NULL` or its expiry is in the past. `claim()` reads the current epoch on the primary, then runs one compare-and-set `UPDATE` conditioned on that epoch; `renew()` and `release()` are one conditional `UPDATE` each. The affected-row count says whether this owner won.

- `claim(target, owner, ttlMs, now, extraWhere?)` takes a free row, sets the owner and `now + ttlMs`, increments the epoch and returns the new epoch, or `null` when the row is held or missing. `extraWhere` adds equality conditions (`null` means `IS NULL`).
- `renew(target, owner, epoch, ttlMs, now)` extends the expiry while this owner still holds this epoch.
- `release(target, owner, epoch)` clears the owner and the expiry and keeps the epoch.
- `fenced(target, owner, epoch)` returns the equality conditions (key, owner, epoch) for a write that must commit only while this owner holds this epoch. After another owner's claim such a write affects 0 rows.

The default columns are `ClaimedBy`, `ClaimedUntil` and `ClaimEpoch`; pass `{ owner, until, epoch }` to use others. The epoch column must be `NOT NULL` with a default of `0`. Pass `now` from `DbClock`, never from the replica's own clock. On MySQL the connection must report found rows (mysql2's default): otherwise a renewal that writes identical values reads as a lost lease.

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { DbClock, RowLease } from '@spinajs/durable';

export async function finishJob(id: string, replicaId: string): Promise<boolean> {
  const driver = (await DI.resolve(Orm)).Connections.get('default')!;
  const lease = new RowLease(driver);
  const target = { table: 'jobs', key: { Id: id } };
  const now = await DI.resolve(DbClock).sync();

  const claim = await lease.claim(target, replicaId, 60_000, now, { Status: 'due' });
  if (!claim) return false;
  await driver.update().in('jobs').update({ Status: 'done' }).where(lease.fenced(target, replicaId, claim.epoch));
  return lease.release(target, replicaId, claim.epoch);
}
```

## Fault points

`FaultPointName` lists every point: `outbox.after-insert`, `outbox.after-publish`, `outbox.before-mark`, `workflow.after-step-fn`, `workflow.before-journal`, `workflow.after-journal`, `workflow.lease-renew`, `scheduler.lease-renew`, `queue.before-ack` and `idempotency.after-claim`. Production code calls `await faults.point(name, detail)`; only a test harness registers an implementation other than `NoFaults`.

## The scheduler

`@spinajs/scheduler` imports all of this from here and re-exports every symbol under its old name, so 3.x imports keep working: `SchedulerSystemClock` is `DurableSystemClock`, and `FakeClock` and `FakeDbTimeSource` are still exported from `@spinajs/scheduler`.
