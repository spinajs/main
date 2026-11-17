# `@spinajs/scheduler`

The package reference is [`packages/scheduler/README.md`](../../packages/scheduler/README.md) and its [configuration page](../../packages/scheduler/docs/configuration.md). This folder documents what was added in 4.x.

## Inline runs

`SchedulerService.runInline(schedule, fn, opts?)` runs `fn` now, in the calling process, as a `manual` run of `schedule`, and resolves with what `fn` returns. It is how app code starts tracked work itself.

```ts sample
import { DI } from '@spinajs/di';
import { RunContext, Schedule, ScheduledTask, SchedulerService } from '@spinajs/scheduler';

@Schedule('rebuild-search-index', { manual: true, overlap: 'skip' })
export class RebuildSearchIndex extends ScheduledTask {
  public async execute(ctx: RunContext): Promise<{ documents: number }> {
    return rebuild(ctx);
  }
}

async function rebuild(ctx: RunContext): Promise<{ documents: number }> {
  return ctx.step('index', () => ({ documents: 0 }));
}

export async function rebuildNow(): Promise<{ documents: number }> {
  const scheduler = await DI.resolve(SchedulerService);
  return scheduler.runInline('rebuild-search-index', (ctx) => rebuild(ctx), { triggeredBy: 'admin-panel' });
}
```

### How it works

1. Finds the schedule's definition. A schedule declared after the registry was built (its class was imported lazily) is adopted on first use and its `__scheduler_schedule` row is inserted. An unknown name throws `ScheduleNotFound`; a hard-paused schedule throws `SchedulePaused`.
2. Takes the schedule lease, whatever the schedule's `overlap`: an inline call never waits. When another run holds the lease, throws `ScheduleOverlap` (a `RunConflict`: HTTP 409, CLI exit 3) and writes nothing. A schedule row that was pruned while its definition lives on is inserted again first. Runs of a `runOn: 'all'` schedule take no schedule lease (`Forced`) and are per replica instead: a call throws `ScheduleOverlap` while this replica already runs the schedule (another inline call, or a live run row leased to this replica, such as the loop's).
3. Inserts the run row already `running` and leased to this process, trigger `manual`, `TriggeredBy` `{ kind: 'service', id: opts.triggeredBy }` (default `{ kind: 'system', id: 'inline' }`), and `Params` from `opts.params` when it is an object. No scheduler loop can claim it.
4. Executes `fn(ctx)` with the run's `RunContext` (also through `currentRunContext()`), under the run heartbeat that renews the run and schedule leases, and with the schedule's `timeout`.
5. Finishes the run (`succeeded` with the value as `Result`, or `failed` with the error), journals it, releases the schedule lease and runs the usual finalizers: health, error groups, metrics and the `ScheduleRun*` events.
6. Resolves with the value, or rejects with the error `fn` threw. A run that ended otherwise (cancelled, timed out, lease lost) rejects with `RunAbortedError`.

### Important behaviour

- **No automatic retries.** The caller gets the failure; the schedule's `retry` policy does not apply to inline runs, because a retry would run the schedule's task, not `fn`.
- **No emit.** An emit-mode schedule's inline run executes `fn` in process; the job is not sent.
- **The schedule's own task is not called.** Only `fn` runs; `execute()` of the schedule class runs for `runNow`, `retry` and timed occurrences.
- **A crash writes nothing.** When `fn` throws an error carrying `crash: true` (a dead process in tests and the simulation), the run is not finished, nothing is journaled, the leases are not released and the error is rethrown; the run stays `running` until its lease expires and a scheduler loop reaps it. A crash inside `ctx.step()` leaves the step as it was: no `failed` status, no `step-end`. Runs the scheduler loop executes follow the same contract: after a crash the run and its open step stay `running`, nothing more is journaled, no finalizer runs and no lease is released.
- **A failure of the scheduler's own writes rejects with that error.** The schedule lease is released best-effort; the run row keeps its lease until it expires.
- **`SchedulerService` subclasses written before 4.x** inherit a `runInline` that rejects with `MethodNotImplemented`.

## Tracing

Every attempt of a run executes under an OpenTelemetry span on the provider `@spinajs/tracing` owns.

- **A run the scheduler loop starts** gets a root span `run <schedule>` (kind INTERNAL): the loop claims the run long after whatever queued it, so it starts a trace of its own. Each `ctx.step(name, …)` gets a child span `step <name>`.
- **An inline run** (`runInline`) gets the same `run` span, as a child of the span that called `runInline`. A failure of its body marks the `run` span and the failing `step` span, never the caller's; the caller's span is marked only by whoever owns it, when the rethrown error reaches it.
- **A run in emit mode** gets a root `run` span too, and publishes its job under it.
- **Attributes.** The `run` span carries `spina.scheduler.run_id`, `spina.scheduler.schedule`, `spina.scheduler.attempt` and `spina.scheduler.trigger`; a `step` span carries `spina.scheduler.step`. A step answered from the resume map, whose body does not run again, is marked `spina.scheduler.replayed=true`.
- **Links across retries and resumes.** The `traceparent` of each attempt's `run` span is kept in `__scheduler_run_attempt.TraceParent` (migration `Scheduler_2026_11_16_00_00_00`). An automatic retry links to the previous attempt of the same run; a run that resumes another run (`ResumeFrom`) links to that run's last attempt. Both carry `spina.scheduler.resumed=true`. A link holds only the span context of the continued attempt (trace id, span id, trace flags), no attributes. Attempts written before the migration, or while tracing is disabled, have no `TraceParent` and their successors no link.
- **Failures are recorded by class only.** A step that throws, and a run whose task throws or whose emit fails or times out, set `error.type` to the error's class name and an ERROR status with that name as its message; the error's message, the run's parameters and step results never reach a span. A run ended by a timeout, a lost lease or a cancel settles as aborted and keeps an UNSET `run` span; its reason is in the run's `Reason`. The error's text is in the run's `Error`, in its journal, and in the `run … ended <status>: <Name>: <message>` log line, which is written inside the `run` span and so carries its `traceId` and `spanId`.
- **Names go onto spans verbatim.** The schedule name is in the `run` span's name and attributes, a step name in the `step` span's name and attributes; a name built from parameters or other input puts that input on a span, so keep names to fixed identifiers.
- **A step whose body never settles** after an abort and the grace period leaves its `step` span open: it is never ended and never exported, while the `run` span above it ends.
