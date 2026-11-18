# @spinajs/idempotency-scheduler

The sweep of [`@spinajs/idempotency`](../idempotency/README.md) as a builtin schedule of `@spinajs/scheduler`. Expired
replies and claims whose lease ended stay in the `__idempotency` table until a sweep deletes them; this package runs
that sweep.

## Install

```bash
npm install @spinajs/idempotency-scheduler
```

Import it once in the app entry, before the boot:

```ts
import '@spinajs/idempotency-scheduler';
```

The import registers the schedule; the scheduler reads it when it starts. An app that installs the package and does not
import it has no sweep. The app must run `@spinajs/scheduler` (`await DI.resolve(Scheduler)`).

## The schedule

| | |
|---|---|
| Name | `idempotency.sweep` |
| Interval | `idempotency.sweepEvery`, default `5m` |
| Replicas | `runOn: 'leader'`: one replica runs each occurrence |
| Overlap | `overlap: 'skip'`: an occurrence is skipped while the previous run is going |
| Result | `{ swept, batches }`: rows deleted, and `IdempotencyService.sweep()` calls made |
| Log | one `info` line per run on the `SCHEDULER` logger, with the run id: `idempotency sweep: 12 rows deleted in 2 batches` |

A run calls `IdempotencyService.sweep()`, which deletes at most `idempotency.sweepBatch` rows, until a call deletes
nothing. Stopping the scheduler ends the run before its next batch; the next run goes on from the rows that are left.
The task declares no retry: a failed run is followed by the next occurrence.

## What a run deletes

A sweep deletes a completed key whose reply expired (its `ttl` ended) and a claim whose lease ended without a renewal,
the claim of a replica that died. It never deletes a key whose reply is still kept, nor a claim whose lease still runs:
a call in flight renews its lease, so its row stays. Times are database time. The delete repeats the condition of the
select, so a row claimed again between the two stays; two replicas sweeping at once delete each row once.

## Configure

`idempotency.sweepEvery` sets the interval. It takes a duration string (`'5m'`, `'90s'`); a number is refused when the
configuration is validated. A `scheduler.schedules` entry named `idempotency.sweep` overrides any option of the
schedule, as for every schedule:

```ts
export default {
  scheduler: {
    schedules: [
      // another interval, and a retry of a failed run
      { name: 'idempotency.sweep', every: '1m', retry: { attempts: 3, delay: '30s' } },
    ],
  },
};
```

Switch it off with `{ name: 'idempotency.sweep', enabled: false }`: the schedule stays listed and no longer fires.

## See its runs, trigger it, pause it

The schedule is one of the scheduler's, so its tools apply
([`@spinajs/scheduler`](../../packages/scheduler/README.md#cli),
[`@spinajs/scheduler-http`](../../packages/scheduler-http/README.md#endpoints)):

| To | CLI | HTTP (`@spinajs/scheduler-http`) |
|---|---|---|
| see the schedule, its next run, health and last run | `scheduler:show idempotency.sweep` | `GET /scheduler/schedules/idempotency.sweep` |
| list its runs | `scheduler:runs idempotency.sweep` | `GET /scheduler/runs?schedule=idempotency.sweep` |
| read one run: status, result `{ swept, batches }`, log line | `scheduler:run:show <id>` | `GET /scheduler/runs/<id>` |
| run it now | `scheduler:run idempotency.sweep --wait` | `POST /scheduler/schedules/idempotency.sweep/runs` |
| stop and restart scheduled firing | `scheduler:pause idempotency.sweep`, `scheduler:resume idempotency.sweep` | `POST /scheduler/schedules/idempotency.sweep/pause`, `…/resume` |

The HTTP routes need the `scheduler:read`, `scheduler:run` and `scheduler:manage` permissions.

## Without this package

Call `IdempotencyService.sweep()` yourself until it answers 0, from a timer the app already has.

## Why a package of its own

`@spinajs/scheduler` depends on `@spinajs/queue`, and the queue's consumer dedup (`queue.deduplicateEvents`) uses
`@spinajs/idempotency`. A schedule inside `@spinajs/idempotency` would make the three depend on each other in a circle.
