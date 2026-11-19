# @spinajs/workflow

Durable workflows on the application's own database. A workflow is a class whose `run(ctx)` is plain async
TypeScript; `ctx.step`, `ctx.sleep`, `ctx.waitForEvent` and `ctx.emit` are journaled, so `run` replays from the
top after every wake-up or crash and continues where it stopped. See `docs/workflow/`.

## Fan-outs

Each step row records how many results the workflow had received when the step was called (`Meta.after`) and the
order its result was committed in (`Meta.order`). A replay hands recorded results back in that order, one per
event-loop turn, each only once the calls that preceded it have been made again. Results are handed back in their
recorded order; a call may be made earlier or later than the first time. A sleep that woke and a wait that consumed
an event or timed out are results like a step's; `ctx.now()`, `ctx.uuid()` and `ctx.random()` return synchronously
and are not.
The contract:

- Keys are counted per branch. Durable calls made in one synchronous turn (`Promise.all([ctx.step(...), ...])`,
  `items.map(async (item) => { await ctx.step(...); ... })`) are siblings, and the code after each of them is a branch
  of its own, whose keys end in `@<branch>`. A step name used in such branches names one call per branch, whatever
  the timing. Non-durable awaits between the steps of a branch are safe, and so are `ctx.now()`, `ctx.uuid()` and
  `ctx.random()` inside a branch. Sequential code keeps its keys (`step:save#1`, `step:save#2`).
- **A branch must make a durable call before any non-durable await.** A branch that first awaits something else (an
  HTTP call, a file read, a timer) has no identity yet: its calls are counted in the order they happen to be made.
  Either make a durable call first, or give such branches per-item step names (`save:${id}`).
- **What goes wrong when branches share one count.** In the case above and in the five below, several pieces of
  code number their calls together, in the order they happen to run. After a crash, a replay with other timing
  either hands one caller the journaled result of another without any error, or fails the instance with
  `NonDeterminismError` although the code did not change. An instance that failed with `non-determinism` is not
  compensated.
- After `Promise.race`, `Promise.any` or a `Promise.all` that rejected, the code that follows shares a branch with the
  last call of the fan-out. If code chained to that call is still making durable calls, the two are counted together
  by timing. Put the call that has code chained to it first, or wait for every branch (`Promise.allSettled`).
- Start concurrent durable calls in one synchronous turn. A call started later, next to one that is still running,
  is counted after it in the same branch.
- A concurrency limiter (`p-limit`, `p-map`, a hand-written pool) starts most of its tasks later, in the context of
  whichever task has just finished, so none of them is a branch. Give the steps of limited tasks per-item names.
- A wrapper that restores the whole async context around each branch (`AsyncResource.runInAsyncScope`, a callback
  made with `AsyncResource.bind`) hides the branches from each other; they count as one. Give their steps per-item
  names. `AsyncLocalStorage.run()` of another store, such as a tracing span, is safe.
- Branches that all await one durable promise (`const user = ctx.step('load', ...)`, then `await user` in every
  branch) resume as one branch. Await that call before the fan-out and start each branch with a durable call of
  its own, or give their steps per-item names.
- With per-item step names every recorded result belongs to exactly one call, so the moment a call is made may
  differ between the first run and a replay.
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
- A replay fails with `NonDeterminismError` when it can see the code changed: a call where its branch recorded
  another one, or a repeated name called under another number in its branch. Each journal row keeps the number of
  its call in its branch, so a crash in the middle of a fan-out, which leaves some calls unrecorded, is not mistaken
  for a change. A recorded step that is never asked for again fails the replay when the stall timer fires
  (`workflow.leaseTtl`) or at the end of the run.

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

## Tracing

Activations and step attempts run under OpenTelemetry spans on the provider `@spinajs/tracing` owns.

- **Activations.** Each activation (one claim of an instance by the engine) runs under a root span `workflow <name>`
  (kind INTERNAL): it runs on the engine loop, long after `start()` returned, so it starts a trace of its own. It
  carries `spina.workflow.name`, `spina.workflow.instance_id` and `spina.workflow.version`.
- **The link to the start.** `start()` keeps the `traceparent` of the span it ran in in `__workflow.TraceParent`, and
  every activation of the instance links to it. An instance started outside a span, or while tracing was disabled,
  keeps `null` and its activations have no link; so does a malformed stored value, which never fails an activation.
  The link holds only the span context of the start (trace id, span id, trace flags).
- **Steps.** Each step attempt whose body runs gets a child span `step <name>` with `spina.workflow.step` and
  `spina.workflow.step_attempt`; a retry is a new span in a later activation, with the next attempt number. A step
  answered from the journal on a replay gets no span. Sleeps, waits, `ctx.emit`, markers and compensations get no
  span of their own; compensations run inside the activation span.
- **What marks a span.** A step attempt that throws (its body, a result over `maxStepResultBytes`, a journal write
  that fails, an abort the body observes) sets `error.type` to the error's class name and an ERROR status with that
  name as its message. An activation that ends the instance `failed` (an error, `ctx.fail()`, the instance timeout,
  non-determinism, `compensation-failed`) sets an ERROR status with the fixed word `failed`; an activation that
  throws inside the engine (a crashed replica, a database error) records the error's class like a step. Every other
  activation stays UNSET: one that parks, completes, ends `compensated` or `cancelled`, and one that is abandoned
  (lost lease, failed journal write, shutdown), because none of them ends the instance failed; an abandoned
  activation replays later.
- **No message reaches a span.** Error messages, input, step results and events never go onto a span. The error's
  text is in the instance's `Error` and in the step's journal row.
- **Names go onto spans verbatim.** The workflow name is in the activation span's name and attributes, a step name in
  the step span's. A per-item step name (`save:${id}`) puts that id on a span: build step names from identifiers,
  never from personal data or secrets.
- **A step whose body never settles** after an abort and the grace period leaves its `step` span open: it is never
  ended and never exported, while the activation span above it ends.
