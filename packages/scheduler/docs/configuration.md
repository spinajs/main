# Scheduler configuration reference

All keys live under `scheduler`. Durations accept milliseconds (a number) or a
string with a unit: `500ms`, `10s`, `5m`, `2h`, `30d`, `1w`. Keys typed as
milliseconds below take a number only. The shipped defaults equal
`SCHEDULER_DEFAULTS`; the schema `SCHEDULER_CONFIGURATION_SCHEMA` validates the block
at boot.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | start the loop when `Scheduler` is resolved |
| `tick` | `1000` | ms (min `100`); upper bound between due checks |
| `leaseTtl` | `60000` | ms (min `3000`); renewed every `leaseTtl / 3` while a run is in progress; a run not renewed for this long is reaped and shown `stale` |
| `shutdownGrace` | `30000` | ms to wait for aborted runs to stop; pending event sends then get at most `min(shutdownGrace, 5000)` ms more |
| `progressFlush` | `1000` | ms (min `100`); minimum interval between progress writes per run |
| `runLogLimit` | `1000` | per-run cap for each of the `log`, `message` and `progress` journal kinds; `status`, step and `error` rows are never dropped |
| `maxStepResultBytes` | `65536` | larger step results are not stored (a resumed retry runs the step again) |
| `emitTimeout` | `'24h'` | duration; an `emitted` run whose `queue_jobs` row does not appear within it (or within the schedule's `timeout`, when longer) ends `failed` / `emit-timeout`; set it above the worst queue wait |
| `retention.enabled` | `true` | register the builtin `scheduler-retention` schedule |
| `retention.schedule` | `'30 3 * * *'` | cron of the retention schedule (UTC) |
| `retention.runs` | `'30d'` | terminal runs finished longer ago are deleted with their attempts, steps and journal |
| `retention.logs` | `'7d'` | `log`, `message` and `progress` journal rows older than this are deleted |
| `retention.errors` | `'90d'` | resolved error groups last seen longer ago are deleted |
| `events.pollInterval` | `1000` | ms (min `100`); how often live subscriptions poll the journal for events written by other replicas |
| `cli.http.baseUrl` | unset | where `--follow` reads the SSE stream of `@spinajs/scheduler-http`; unset = subscribe in-process |
| `cli.http.headers` | unset | extra request headers for that stream (e.g. `Authorization`) |
| `schedules` | `[]` | schedules from configuration (below) |

The package's shipped configuration also adds `system.dirs.cli` (its commands),
an empty `system.dirs.schedules` (append your schedule folders; their files are
imported at boot) and `queue.routing` entries that send the seven scheduler events
to the black-hole connection `scheduler-empty-queue`. Route an event elsewhere
with `queue.routing.<EventName>.connection`.

## Schedule options

The same options are accepted by `@Schedule(name, options)` and by a `schedules[]`
entry.

| Option | Default | Meaning |
|---|---|---|
| `cron` / `every` / `at` / `manual` | one is required | cron with an optional seconds field; a duration in whole seconds, at least `1s`; an ISO-8601 instant; `true` for on-demand only |
| `timezone` | `'UTC'` | IANA zone for `cron` and offset-less `at` (DST rules in the README) |
| `jitter` | `0` | random `0..jitter` added to each fire time |
| `misfire` | `'run-once'` | `skip`, `run-once` or `catch-up(n)` with `n >= 1` |
| `misfireThreshold` | `max(2 × tick, 5s)` | how late an occurrence may be seen before it counts as missed |
| `overlap` | `'skip'` | `skip` records a `skipped` run while one is in progress; `queue` keeps one `queued` run |
| `runOn` | `'leader'` | `leader`: one replica, leased; `all`: every replica from local timers (no lease, no automatic retries, no misfire handling) |
| `emit` | none | a `QueueJob` class; code only; not with `runOn: 'all'` |
| `params` | none | JSON Schema for parameters of manual runs; without it a manual run takes no parameters |
| `retry.attempts` | no retries | total attempts including the first one (integer `>= 1`) |
| `retry.backoff` | `'fixed'` | `fixed` or `exponential` (`delay × 2^(attempt-1)`, ±10 % jitter) |
| `retry.delay` | `'1m'` | first retry delay |
| `retry.maxDelay` | `max(delay, 1h)` | cap of the exponential delay |
| `retry.retryOn` | retry every error | `(err) => boolean`; code only; not consulted for `shutdown` / `lease-expired` aborts |
| `resumable` | `false` | retries skip completed steps and receive the last checkpoint |
| `timeout` | none | maximum run duration; the run is aborted with reason `timeout` |
| `pauseAfterFailures` | off | integer `>= 1`; auto-pause after that many consecutive counted failures |
| `enabled` | `true` | a disabled schedule never fires on its own |

The schedule's `retry` is ignored (with a boot warning) in emit mode, where the
queue retries the job, and for `runOn: 'all'`.

## Schedules in configuration

A `schedules[]` entry with the name of a `@Schedule` class overrides that
decorator's options; setting any of `cron`/`every`/`at`/`manual` replaces the
decorator's timing. An entry with `task: '<ClassName>'` creates another schedule
from that `@Schedule` class (starting from its options); `task` can also name a
`@Task` method of `@spinajs/tasks` (README, "Scheduling a `@Task` method"). A class
name wins over a `@Task` with the same name. Names are at most 128 characters.
`emit` and `retry.retryOn` can only be set in code.

```ts sample
import type { ConfigScheduleEntry } from '@spinajs/scheduler';

const schedules: ConfigScheduleEntry[] = [
  { name: 'reconciler', every: '60s' },
  { name: 'reconciler-nightly', task: 'Reconciler', cron: '0 1 * * *', timezone: 'Europe/Warsaw' },
  {
    name: 'import-rates',
    retry: { attempts: 3, backoff: 'exponential', delay: '1m', maxDelay: '30m' },
    pauseAfterFailures: 5,
  },
  { name: 'digest', task: 'send-digest', cron: '0 8 * * *', retry: { attempts: 3 } },
  { name: 'scheduler-retention', enabled: false },
];

const config = {
  scheduler: {
    tick: 1000,
    leaseTtl: 60000,
    emitTimeout: '6h',
    retention: { runs: '14d', logs: '3d', errors: '60d' },
    cli: { http: { baseUrl: 'https://api.example.com/api', headers: { Authorization: 'Bearer <token>' } } },
    schedules,
  },
  queue: {
    routing: {
      ScheduleRunFailed: { connection: 'alerts' },
      ScheduleDead: { connection: 'alerts' },
    },
  },
};

export default config;
```

## Declaring in code

```ts sample
import { NonRetryableError, RunContext, Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('import-rates', {
  cron: '0 2 * * *',
  timezone: 'Europe/Warsaw',
  params: { type: 'object', properties: { file: { type: 'string' } } },
  retry: {
    attempts: 3,
    backoff: 'exponential',
    delay: '1m',
    maxDelay: '30m',
    retryOn: (err) => !(err instanceof TypeError),
  },
  resumable: true,
  timeout: '2h',
  pauseAfterFailures: 5,
})
export class ImportRates extends ScheduledTask {
  public async execute(ctx: RunContext): Promise<unknown> {
    const file = typeof ctx.params.file === 'string' ? ctx.params.file : 'rates.csv';
    ctx.expectSteps(2);
    const rows = await ctx.step('download', async () => {
      if (!file.endsWith('.csv')) throw new NonRetryableError(`not a csv: ${file}`);
      return [{ code: 'EUR', rate: 4.31 }];
    });
    await ctx.step('store', async (s) => {
      s.progress({ done: rows.length, total: rows.length });
      await ctx.checkpoint({ stored: rows.length });
    });
    ctx.log.info('rates imported', { count: rows.length });
    ctx.result({ imported: rows.length });
    return rows.length;
  }
}
```

## Using the service

`SchedulerService` is what the CLI and `@spinajs/scheduler-http` use. Importing
`@spinajs/scheduler` registers `DefaultSchedulerService` for it; resolving it does
not start the loop.

```ts sample
import { DI } from '@spinajs/di';
import { RunConflict, SchedulerService } from '@spinajs/scheduler';

export async function importNow(file: string): Promise<string> {
  const service = await DI.resolve(SchedulerService);
  try {
    const { runId, run } = await service.runNow('import-rates', {
      params: { file },
      triggeredBy: { kind: 'user', id: '42', name: 'admin' },
      wait: { timeoutMs: 60_000 },
    });
    return `${runId}: ${run?.status ?? 'unknown'}`;
  } catch (err) {
    if (err instanceof RunConflict) return `busy with ${err.runId ?? 'another run'}`;
    throw err;
  }
}
```
