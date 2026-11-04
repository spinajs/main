# `@spinajs/scheduler`

The package reference is [`packages/scheduler/README.md`](../../packages/scheduler/README.md) and its [configuration page](../../packages/scheduler/docs/configuration.md). This folder documents what was added in 4.x.

## Inline runs

`SchedulerService.runInline(schedule, fn, opts?)` runs `fn` now, in the calling process, as a `manual` run of `schedule`, and resolves with what `fn` returns. It is how app code starts tracked work itself, and how the deprecated `@Task()` decorator of `@spinajs/tasks` runs every call.

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
2. Takes the schedule lease, whatever the schedule's `overlap`: an inline call never waits. When another run holds the lease, throws `ScheduleOverlap` (a `RunConflict`: HTTP 409, CLI exit 3) and writes nothing. A schedule row that was pruned while its definition lives on is inserted again first. Two kinds of run take no schedule lease (`Forced`) and run side by side: runs of a `runOn: 'all'` schedule, and runs of the schedule a `@Task` with `taskStacking: true` registers.
3. Inserts the run row already `running` and leased to this process, trigger `manual`, `TriggeredBy` `{ kind: 'service', id: opts.triggeredBy }` (default `{ kind: 'system', id: 'inline' }`), and `Params` from `opts.params` when it is an object. No scheduler loop can claim it.
4. Executes `fn(ctx)` with the run's `RunContext` (also through `currentRunContext()`), under the run heartbeat that renews the run and schedule leases, and with the schedule's `timeout`.
5. Finishes the run (`succeeded` with the value as `Result`, or `failed` with the error), journals it, releases the schedule lease and runs the usual finalizers: health, error groups, metrics and the `ScheduleRun*` events.
6. Resolves with the value, or rejects with the error `fn` threw. A run that ended otherwise (cancelled, timed out, lease lost) rejects with `RunAbortedError`.

### Important behaviour

- **No automatic retries.** The caller gets the failure; the schedule's `retry` policy does not apply to inline runs, because a retry would run the schedule's task, not `fn`.
- **No emit.** An emit-mode schedule's inline run executes `fn` in process; the job is not sent.
- **The schedule's own task is not called.** Only `fn` runs; `execute()` of the schedule class runs for `runNow`, `retry` and timed occurrences.
- **A crash writes nothing.** When `fn` throws an error carrying `crash: true` (a dead process in tests and the simulation), the run is not finished, nothing is journaled, the leases are not released and the error is rethrown; the run stays `running` until its lease expires and a scheduler loop reaps it. A step that `fn` had open still records its own failure.
- **A failure of the scheduler's own writes rejects with that error.** The schedule lease is released best-effort; the run row keeps its lease until it expires.
- **`SchedulerService` subclasses written before 4.x** inherit a `runInline` that rejects with `MethodNotImplemented`.
