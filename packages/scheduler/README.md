# @spinajs/scheduler

Recurring and manual jobs for SpinaJS apps, safe with any number of replicas and
no broker: one run per occurrence, decided by atomic updates on the app database
(PostgreSQL, MySQL or SQLite), compared against database time.

Every execution is a tracked **run** with steps, progress, messages, log lines,
checkpoints, a result and structured errors. Failed runs retry by policy and can
resume from the last completed step. Errors are grouped by fingerprint, and a
schedule can pause itself after repeated failures. Everything is available through
`SchedulerService`, the `scheduler:*` CLI commands and (with
`@spinajs/scheduler-http`) HTTP endpoints with live updates.

## Install

```bash
npm install @spinajs/scheduler
```

The package ships its migration (`Scheduler_2026_10_15_00_00_00`, connection
`default`), its default configuration and its CLI commands. `@spinajs/queue` (events,
emit mode) and `@spinajs/telemetry-common` (metrics) are regular dependencies;
`@spinajs/tasks` is an optional peer, needed only to schedule `@Task` methods.

## Declare a schedule

```ts
import { RunContext, Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('reconciler', { every: '5m', jitter: '10s', misfire: 'run-once', overlap: 'skip' })
export class Reconciler extends ScheduledTask {
  public async execute(ctx: RunContext) {
    const forges = await ctx.step('load forges', () => loadForges());
    await ctx.step('poll forges', async (s) => {
      for (const [i, f] of forges.entries()) {
        s.progress({ done: i, total: forges.length, message: `polling ${f.id}` });
        await poll(f, ctx.signal);
      }
    });
  }
}
```

Put schedule classes in a folder listed in `system.dirs.schedules` (the files are
imported at boot so their decorators run), or import them yourself.

Options: `cron` (5 or 6 fields) / `every` (whole seconds, at least `1s`) / `at` (ISO
instant) / `manual`, `timezone`, `jitter`, `misfire` (`skip`, `run-once`,
`catch-up(n)`), `misfireThreshold`, `overlap` (`skip`, `queue`), `runOn` (`leader`,
`all`), `emit` (a `QueueJob` class), `params` (JSON Schema for manual runs), `retry`
(`attempts` = total attempts, `backoff`, `delay`, `maxDelay`, `retryOn`),
`resumable`, `timeout`, `pauseAfterFailures`, `enabled`. A configuration entry with
the same name overrides the decorator. Defaults and the configuration form are in
[docs/configuration.md](docs/configuration.md).

## Start the scheduler

```ts
import { DI } from '@spinajs/di';
import { Scheduler } from '@spinajs/scheduler';

await DI.resolve(Scheduler); // validates every schedule, syncs them, starts the loop
```

Resolve it after the ORM. Boot fails with `ScheduleValidationError` listing every
invalid schedule (bad cron, unknown time zone, unknown task, duplicate name, name
over 128 characters, invalid `params` schema, `emit` with `runOn: 'all'`).

A process that only serves the API or runs CLI commands resolves
`SchedulerService` and never starts the loop. Only the loop owns the stored
definitions: it inserts, rewrites, orphans and un-orphans schedule rows. The
service and `scheduler:run --local` only insert rows that are missing, so a
schedule removed from code stays in the table until a loop replica that no longer
knows it boots and marks it orphaned.

**Shutdown.** `DI.dispose()` (or `scheduler.stop()`) stops claiming, aborts running
runs with reason `shutdown`, waits up to `shutdownGrace` for them, then waits at
most `min(shutdownGrace, 5 s)` for pending event sends. Runs of schedules with a
retry policy become `retrying`; others end `aborted`. `@spinajs/di` disposes
services in reverse resolution order, so `DI.dispose()` stops the scheduler before
the ORM connection it writes to closes, and the queue service (resolved when the
scheduler starts) after it.

**`@Task` files and migrations.** `@spinajs/tasks` registers its `__tasks`
migration when it is imported. Import `@spinajs/tasks` (or your `@Task` files)
before the ORM boots; a `@Task` file first imported through
`system.dirs.schedules` comes too late for the migration.

## Inside a run: `RunContext`

| Member | Use |
|---|---|
| `runId`, `schedule`, `trigger`, `attempt`, `scheduledAt`, `firedAt`, `params`, `triggeredBy` | identity |
| `signal` | aborted on cancel, timeout, lease loss or shutdown; pass it to I/O |
| `step(name, fn, { weight?, persistResult? })` | a named, timed, recorded step; resumed retries skip completed steps and return their stored result |
| `progress(0..100 \| { done, total, message? })` | progress of the current step, rolled up to the run; written at most every `progressFlush` ms |
| `expectSteps(totalWeight)` | tells the roll-up the total step weight (else the last succeeded run's steps, else the steps seen so far) |
| `message(text, level?)` | short status line on the run and step |
| `log.trace/debug/info/warn/error(message, data?)` | the `SCHEDULER` logger; `info` and above are also stored as run log lines (capped per run) |
| `checkpoint(data)` / `lastCheckpoint` | JSON checkpoint on the run row |
| `result(data)` | JSON result (otherwise the return value of `execute`) |

`currentRunContext()` returns the same context from code that cannot take it as a
parameter (a scheduled `@Task` method); it is `undefined` outside a run.

Throw `NonRetryableError` to fail without automatic retries. Weights must be finite
and `>= 0`; one step runs at a time (a nested or concurrent `step()` throws).

**Step names are a fixed set.** They label the `scheduler_step_duration_seconds`
metric; a data-derived name such as `` `page-${i}` `` grows the series without bound.

## Guarantees

- One replica fires each occurrence: `UPDATE __scheduler … WHERE NextRunAt = :expected AND (lease free)`, with `NextRunAt` advanced in the same statement.
- Leases are renewed every `leaseTtl / 3`; a replica that loses its lease aborts the run and journals nothing more. A crashed replica's run is reaped after the lease expires and retried elsewhere when the schedule has a retry policy.
- Ownership decisions use database time read once per tick, so a replica whose own clock is wrong still claims correctly.
- MySQL: exactly-once relies on mysql2's default `CLIENT_FOUND_ROWS` flag (affected rows = matched rows). Do not turn it off for the scheduler's connection.
- A statement retried by the driver after a lost reply can turn a won claim into a reported loss (a skipped occurrence, or a run reaped after `leaseTtl`), never into two winners.
- Live streams work from any replica. Schedule streams use a commit-ordered journal position as the SSE id, so a client reconnecting to another replica with `Last-Event-ID` misses no event.
- Stored `progress` events are capped per run (`runLogLimit`); after the cap, subscribers still get the latest value per step as `progress` events marked `synthetic: true`, which repeat the stream position and never move `Last-Event-ID`.
- A run whose row has not been updated for `leaseTtl` while `running` is reported `stale: true`.

## Time

- `timezone` defaults to `UTC`; cron fields match local wall time in that zone.
- **DST, repeated hour (autumn):** a wall time that occurs twice fires once, at its first pass. Sub-hourly crons pause during the second pass (`*/15` in Europe/Warsaw runs 00:00-00:45 UTC, then 02:00 UTC).
- **DST, gap (spring):** a wall time that does not exist fires shifted forward by the DST shift (Warsaw `30 2 * * *` fires at 03:30 CEST on the transition day); when several matches fall into one gap, only the first fires.
- An `at` without an offset is read as wall time in `timezone`, with the same rules; an `at` with an offset is that instant.
- Stored instants are whole seconds.

## Misfire and overlap

- An occurrence counts as missed when the loop sees it more than `misfireThreshold` late (default `max(2 × tick, 5 s)`), e.g. after downtime. `skip` records one `misfired` run and continues with the next occurrence after now; `run-once` runs the latest missed occurrence once; `catch-up(n)` runs up to the last `n`.
- With `skip`, the latest missed occurrence is folded into the misfire even when it alone is within the threshold. `run-once` and `catch-up` may pick an occurrence whose jittered time is slightly after now.
- Missed counts are exact up to 100 occurrences; beyond that the run message says `missed more than N occurrence(s)`.
- `overlap: 'skip'` records a `skipped` run while one is in progress; `overlap: 'queue'` keeps one `queued` run behind it. A `run-once` / `catch-up` occurrence ignores `overlap`: it waits for the schedule lease.
- `runOn: 'all'` schedules run on every replica from local timers: still recorded as runs, no lease. They ignore `misfire` (after a stall the stale occurrence runs once, then the next after now), do not catch up, and get **no automatic retries** (a `retry` option logs a boot warning). Pause and orphaning stop them from the next tick.

## Retries and resume

- `retry.attempts` is the total number of attempts. `backoff: 'fixed'` waits `delay` (default `1m`); `'exponential'` waits `delay × 2^(attempt-1)` with ±10 % jitter, capped by `maxDelay` (default `max(delay, 1h)`).
- `retryOn(err)` decides for task errors and timeouts. It is not consulted for `shutdown` or `lease-expired` aborts: those retry while attempts remain. `NonRetryableError` never retries; a cancel never retries.
- A retried attempt goes `running → retrying` with no `failed` in between; only its attempt row says `failed`.
- `resumable: true`: a retry skips steps that completed and returns their stored result, and receives the last checkpoint. A non-resumable automatic retry starts without the checkpoint. Steps with `persistResult: false`, a non-JSON value or a value over `maxStepResultBytes` run again on resume; a step that returned `undefined` resumes as `null`.
- **Manual retries** (`retry`, `retryFailed`) create a new linked run at attempt `parent + 1` with `MaxAttempts = attempt + retry.attempts - 1`, so a retry of a `dead` run gets the full automatic budget again. `resume` defaults to the schedule's `resumable`; `fromStep` forces a resume from that step on. `retryFailed` retries run one at a time.
- Two concurrent retries of one run (or two `runNow` calls) can both create a run: overlap is still prevented by the schedule lease, but the work runs twice.

## Manual runs, cancel, pause

- `runNow` conflicts (`RunConflict`, 409 / exit 3) with a queued, running or `retrying` run of the schedule unless `force` is set. With `force` on an `overlap: 'skip'` schedule the run does not take the schedule lease and may overlap.
- A manual run of a `runOn: 'all'` schedule runs once, on the first replica that is not running that schedule locally; it waits while every replica is busy with it.
- Params are validated against the schedule's `params` schema; a schedule without one rejects any params.
- `cancel` ends a `queued`, `retrying` or `emitted` run at once and flags a `running` one; its holder aborts on the next heartbeat. A cancelled run always ends `aborted` / `cancelled`, also when its holder died or it had gone `retrying`; it is neither counted in health nor grouped. A task that succeeds before it notices the cancel stays `succeeded`. Cancelling an `emitted` run does not recall its queue job.
- `pause` stops scheduled firing; manual runs and retries still work. `pause --hard` also refuses `runNow`, `retry` and `retryFailed` (`SchedulePaused`, 409 / exit 3). `resume` clears either pause, resets the consecutive-failure count, and moves a past `NextRunAt` to the next occurrence.

## Error groups and health

- Every failed attempt's error (a retried one too) counts in a group keyed by schedule, error name, normalized message (UUIDs, quoted strings, paths with 2+ segments, hex and numbers are masked) and the top in-app stack frame. A resolved group that sees the error again reopens as a regression.
- Errors of `shutdown` and `cancelled` aborts are not grouped.
- **Health:** a run that ends `failed`, `dead` or `aborted` by `timeout` counts as a consecutive failure. `aborted` by `shutdown`, `lease-lost`, `lease-expired` or `cancelled` is neutral. Success resets the count. `pauseAfterFailures: n` pauses the schedule after `n` counted runs (a manual pause is left alone).

## Emit mode

`@Schedule('daily-digest', { cron: '0 8 * * *', emit: SendDigestJob })` emits one
`SendDigestJob` per occurrence. The job carries `SchedulerRunId`, `Schedule`,
`ScheduledAt` and `Params`. Its job id is a UUIDv5 of `daily-digest:<scheduled ISO
time>` for scheduled and catch-up runs, and of `daily-digest:run:<run id>` for manual
runs and retries (`queue_jobs.JobId` is 36 characters; the readable key is in the
run's message). The run ends `emitted`, and every loop replica's tick mirrors the
`queue_jobs` row onto it until it ends `succeeded`, `failed` or `dead` (progress
capped at 99 until success).

- The queue owns retries: the schedule's `retry` is ignored (boot warning), `maxAttempts` is 1, and a failed emit fails the run. `emit` cannot be combined with `runOn: 'all'`.
- The emit itself is bounded: an emit the transport has not settled within half of `leaseTtl` from the claim ends the run `failed` (a STOMP transport holds sends while the broker is down). On shutdown or cancel the emit gets at most `shutdownGrace`, then the run ends `aborted`. Either way `JobId` is already recorded on the run, and the transport may still deliver the job later; the run does not mirror it then.
- `queue_jobs` must be readable from the scheduler process (the `queue` connection); otherwise mirroring is off, with one warning.
- A run whose job row does not appear within `emitTimeout` (default `24h`, or the schedule's `timeout` when longer) ends `failed` / `emit-timeout`. Set it above the worst queue wait. A job routed to a `BlackHoleQueueClient` is dropped (boot warning) and its runs fail after `emitTimeout`; so does every emit when `queue_jobs` lives in a database the scheduler cannot read.
- Mirrored failures are grouped and count toward health and auto-pause.
- An `emitted` run gets no `progress` events; `getRun()` shows the mirrored progress.
- A manual retry of a failed emit run emits a new job: if the old job still ran, the work runs twice.
- `retention` never purges an `emitted` run; end a stuck one with `cancel`.

## Scheduling a `@Task` method

A configuration entry can name a `@Task` from `@spinajs/tasks` (optional peer):

```ts
schedules: [{ name: 'digest', task: 'send-digest', cron: '0 8 * * *', retry: { attempts: 3 } }]
```

The run is tracked like any other (status, attempts, errors, retries; steps and
progress through `currentRunContext()`), and the task's `__task_history` row is
still written, once per attempt. Manual-run params come from
`currentRunContext()!.params`; the method is called without arguments. An instance
method's class is resolved through DI. The scheduler calls the method without the
`@Task` mutex: its lease already guarantees one runner, so a direct call of the
decorated method elsewhere is not excluded against a scheduled run; trigger it with
`scheduler:run` instead. A `@Schedule` class with the same name as a `@Task` wins.
Config form only; the definition shows the task as `Task:<name>`.

## CLI

| Command | |
|---|---|
| `scheduler:list` | schedules, next run, pause state, health, last run |
| `scheduler:show <name>` | definition, health, recent runs, open error groups |
| `scheduler:run <name> [--params '<json>'] [--param k=v …] [--force] [--wait] [--follow] [--local]` | manual run |
| `scheduler:runs [<name>] [--status <s>] [--limit <n>]` | runs, newest first (limit max 500) |
| `scheduler:run:show <id> [--follow]` | one run with attempts, steps, logs, error and result |
| `scheduler:cancel <id>` | cancel a queued, retrying, running or emitted run |
| `scheduler:retry <id> [--from-step <name>] [--resume\|--no-resume] [--params …]` | linked retry run |
| `scheduler:retry --schedule <name> --failed-since <time>` | one retry per failed run in the window |
| `scheduler:pause <name> [--hard]` / `scheduler:resume <name>` | pause (hard also blocks manual runs) / resume |
| `scheduler:errors [<name>] [--status <s>]`, `scheduler:errors:resolve <fingerprint> [--status <s>]` | grouped errors |
| `scheduler:prune` | schedules a loop replica orphaned, and runs, logs and errors past retention |

- Every command accepts `--json`. Exit codes: `0` ok, `1` run did not succeed (with `--wait`/`--local`) or unexpected error, `2` invalid parameters (also a bad `--limit` or an unknown `--status`), `3` conflict or invalid state, `4` not found.
- `--follow` reads the HTTP live stream of `@spinajs/scheduler-http` when `scheduler.cli.http.baseUrl` (and `headers`) is set, otherwise it subscribes in-process. With `--json` it prints one event per line, then the result. It reconnects with `Last-Event-ID`, retries a refused connection or a 502/503/504 for up to 60 s, and gives up after 5 streams in a row without an event.
- `--local` claims and executes the run in the CLI process (implies `--wait`; follows in-process). Automatic retries run in the same process once due by database time; a retry another replica claims is followed. A `--local` run of an emit schedule stops at `emitted` (exit 1): the CLI does not mirror queue jobs. `--local` replaces a system-cron `npx spinajs scheduler:run` when no replica runs the loop.

## Signals

**Events** (`@spinajs/queue`): `ScheduleRunStarted`, `ScheduleRunSucceeded`,
`ScheduleRunFailed`, `ScheduleRetrying`, `ScheduleDead`, `ScheduleErrorRegressed`,
`SchedulePausedByFailures`. All are routed to the black-hole connection
`scheduler-empty-queue` by default; route them with `queue.routing.<EventName>`.

- `ScheduleRunFailed` follows the health rule (failed, dead, timed-out abort); cancel, shutdown and lease loss send no failure event. `ScheduleDead` follows it. `ScheduleRetrying.Attempt` is the attempt that failed. An emit-mode run sends `ScheduleRunStarted` at dispatch and its final event when the mirror ends it; `ScheduleDead.Attempts` is then the queue's attempt count.
- Sends start in this order: run event, regression, paused-by-failures; delivery order depends on the transport.
- Events are fire-and-forget: a broker that is down or hangs never delays or fails a run. On shutdown pending sends get at most `min(shutdownGrace, 5 s)`. At most 10 000 sends wait at a time; beyond that new events are dropped with one warning.

**Metrics** (`@spinajs/telemetry-common`, rendered by `@spinajs/telemetry`'s
`/metrics`): `scheduler_runs_total{name,status,trigger}`,
`scheduler_run_duration_seconds{name}`, `scheduler_step_duration_seconds{name,step}`,
`scheduler_lag_seconds{name}`, `scheduler_retries_total{name}`,
`scheduler_consecutive_failures{name}`.

- `runs_total` counts final statuses (also `skipped` / `misfired`), never `retrying` or `emitted`. Durations are seconds, buckets 0.1 s to 4 h; a mirrored emit run's duration includes the queue wait.
- Lag is `start - scheduledAt` of the first attempt (for a manual run, its wait in the queue).
- The gauges are per process: a `resume` from the CLI or an API replica resets only that process's series, and a removed schedule's series stays. Alert on `ScheduleInfo.health` / `consecutiveFailures` from the service or HTTP, not on `max by (name)` across replicas.

**Logs:** category `SCHEDULER` with `runId`, `schedule`, `step`, `attempt`; service
actions write audit lines (`audit: true`, `action`, `triggeredBy`).

## Retention

The builtin schedule `scheduler-retention` (cron `scheduler.retention.schedule`,
default `30 3 * * *` UTC, `overlap: skip`, `misfire: run-once`) deletes terminal
runs older than `retention.runs` with their attempts, steps and journal,
`log` / `message` / `progress` journal rows older than `retention.logs`, and
resolved error groups older than `retention.errors`. `status`, step and `error`
rows live as long as their run, so a listed run can always be replayed to its final
status. Its run result is `{ runs, logs, errors }`, where `logs` counts only the
age-based journal deletions. Turn it off with
`scheduler.retention.enabled: false` or a config entry
`{ name: 'scheduler-retention', enabled: false }`. `scheduler:prune` runs the same
purge on demand and also removes orphaned schedules.

## Testing your schedules

`FakeClock` drives both the scheduler's timers and its view of database time:

```ts
const clock = new FakeClock('2026-01-05T10:00:00Z');
DI.register(() => clock).as(Clock);
DI.register(() => clock.dbSource).as(DbTimeSource);
const scheduler = await DI.resolve(Scheduler, [{ replicaId: 'test', autoStart: false }]);
clock.set('2026-01-05T10:05:00Z');
await scheduler.tickOnce();
await scheduler.idle();
```

With `autoStart: false` nothing ticks on its own. The parity table
(`PARITY_CASES`, `runParityCases`, drivers) is exported for `@spinajs/scheduler-http`
and is a test helper, not production API.
