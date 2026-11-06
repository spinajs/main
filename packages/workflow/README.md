# @spinajs/workflow

Durable workflows on the application's own database. A workflow is a class whose `run(ctx)` is plain async
TypeScript; `ctx.step`, `ctx.sleep`, `ctx.waitForEvent` and `ctx.emit` are journaled, so `run` replays from the
top after every wake-up or crash and continues where it stopped. See `docs/workflow/`.

## Fan-outs

Each step row records how many results the workflow had received when the step was called (`Meta.after`) and the
order its result was committed in (`Meta.order`). A replay hands recorded results back in that order, one per
event-loop turn, each only once the calls that preceded it have been made again. Concurrent branches (`Promise.all`,
`Promise.race`) then continue in their original interleaving. A sleep that woke and a wait that consumed an event or
timed out are results like a step's; `ctx.now()`, `ctx.uuid()` and `ctx.random()` return synchronously and are not.
The contract:

- A step name used in several concurrent branches (`ctx.step('save', ...)` inside `items.map(...)`) is replay-safe
  only if the code between those steps awaits workflow operations alone. If it awaits anything else (a file read, an
  HTTP call, a timer), per-item step names (`save:${id}`) are required.
- With per-item step names, awaiting non-durable work between steps is safe for the steps: every recorded result
  belongs to exactly one call. It is not safe for markers: `ctx.now()`, `ctx.uuid()` and `ctx.random()` are keyed by
  call order alone, so in concurrent branches call them before any non-durable await, or take the value from a
  per-item step (``ctx.step(`id:${k}`, () => randomUUID())``).
- A sleep that is not due, a wait without an event and a step waiting out its retry backoff do not suspend the run
  at once: the activation parks only when every durable operation in flight is parked and no new one is called for
  a macrotask. A branch that is still working (steps, another wait that finds its event) can therefore finish a
  `Promise.race` or a `Promise.all` first; once `run()` settled, its result stands and the losers are abandoned (a
  loser that catches that cannot journal anything more). Parallel parks merge: the instance waits if any operation
  waits, wakes at the earliest wake time, and is woken by a signal for any of its pending waits (`WaitingFor` is
  `'*'` when they wait for different names, which is why event names cannot contain `'#'` or `'*'`).
- Code running next to a blocking operation must reach its next durable call without a non-durable await (a timer,
  an HTTP call). Otherwise the park comes first, and that branch continues only when the park wakes.
- A wait that loses a race stays pending: on later replays it keeps consuming events of its name, oldest first. Do
  not race a wait whose name the same run waits for again; the loser would take the later event. A reminder loop
  uses a wait timeout instead:

  ```ts
  for (let i = 0; i < 5; i++) {
    if (await ctx.waitForEvent('approve', { timeout: '1h' })) return 'approved';
    await ctx.step(`remind:${i}`, () => sendReminder());
  }
  ```
- Sequential code is not affected.
- A replay fails with `NonDeterminismError` when it can see the code changed: a new step where the journal recorded
  another one, or a repeated step name called at another position or after another number of results. A recorded
  step that is never asked for again fails the replay when the stall timer fires (`workflow.leaseTtl`) or at the end
  of the run.

## Sagas

- `ctx.step(name, fn, { compensate })` registers `compensate(result, ctx)` once the step succeeds. When the run fails
  (an error, `ctx.fail()`, the instance `timeout`), the instance goes `compensating` and the compensations run newest
  first, in the order the steps' results were journaled, so concurrent branches unwind in the same order every time.
- Each compensation is journaled as `compensate:<step>#<occurrence>` and retried under its step's retry policy; a
  backoff parks the instance `compensating`. A compensation cut off by a crash before its row commits runs again on
  the next owner: make it idempotent, like a step.
- A compensation receives a `CompensationContext` (`instanceId`, `workflow`, `version`, `input`, `signal`, `log`) and
  cannot run durable operations; calling the outer `ctx` inside it throws `WorkflowNestingError`. Journaled follow-up
  work belongs in a queue job or another workflow instance.
- To resume a pass after a crash or a backoff, the engine replays `run()` to collect the compensations: operations with
  a recorded outcome replay, every other one stays pending, and a marker without a recorded value throws
  `WorkflowSuspended`. Code outside steps runs again, as on any replay. The pass undoes all of the journaled steps that
  have a `compensate` or none of them: a replay that cannot reach one again within `max(leaseTtl, shutdownGrace)` ends
  the instance `compensation-failed`.
- A compensation running longer than `workflow.compensationTimeout` (default 3 x `leaseTtl`) has its signal aborted and
  is retried; the engine does not wait for a body that ignores the signal.
- The instance ends `compensated` (`cancelled` after a cancel) with the original `Reason` and `Error`, or `failed` with
  `Reason: 'compensation-failed'` and the original failure in `Error.details`; `retry()` resumes the pass. A run that
  failed with `non-determinism` is not compensated. `cancel()` compensates only with `workflow.compensateOnCancel`.
