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
  Use `ctx.all`, make a durable call first, or give such branches per-item step names (`save:${id}`).
- `ctx.all(items, fn)` and `ctx.branch(name, fn)` name a branch before it runs. Use them when a branch starts with
  non-durable work, and when code goes on after a race:

  ```ts
  await ctx.all(items, async (item) => {
    const price = await pricing.get(item);
    return ctx.step('charge', () => payments.charge(item, price));
  });
  ```

  A branch writes no journal row. `ctx.all` names its branches by index, so the order of `items` must be the same on
  every replay. `ctx.all(items, fn, { concurrency: 4 })` runs at most four branches at a time; each item still has
  the branch of its index. The code after `ctx.all` or `ctx.branch` goes on in the branch the caller was in when it
  made the call. A durable call started earlier in the same synchronous turn still forks as usual: after
  `await Promise.all([ctx.step('a', ...), ctx.branch('b', ...)])` the code is in the branch after `a`.
- To keep a limiter of your own, wrap each task in `ctx.branch`. The branch is named before the task runs, and the
  limiter gets its own context back when the task returns its promise:

  ```ts
  const limit = pLimit(4);
  await Promise.all(items.map((item) => limit(() => ctx.branch(`item:${item.id}`, () => handle(ctx, item)))));
  ```
- **What goes wrong when branches share one count.** In the case above and in the five below, several pieces of
  code number their calls together, in the order they happen to run. After a crash, a replay with other timing
  either hands one caller the journaled result of another without any error, or fails the instance with
  `NonDeterminismError` although the code did not change. An instance that failed with `non-determinism` is not
  compensated.
- After `Promise.race`, `Promise.any` or a `Promise.all` that rejected, the code that follows shares a branch with the
  last call of the fan-out. If code chained to that call is still making durable calls, the two are counted together
  by timing. Use `ctx.branch` for each side of the race, or wait for every branch (`Promise.allSettled`).
- Start concurrent durable calls in one synchronous turn. A call started later, next to one that is still running,
  is counted after it in the same branch.
- A concurrency limiter (`p-limit`, `p-map`, a hand-written pool) starts most of its tasks later, in the context of
  whichever task has just finished, so none of them is a branch. Use `ctx.all(items, fn, { concurrency })`, or wrap
  each task in `ctx.branch` as shown above.
- A wrapper that restores the whole async context around each branch (`AsyncResource.runInAsyncScope`, a callback
  made with `AsyncResource.bind`) hides the branches from each other; they count as one. Call `ctx.branch` inside the
  wrapper. `AsyncLocalStorage.run()` of another store, such as a tracing span, is safe.
- Branches that all await one durable promise (`const user = ctx.step('load', ...)`, then `await user` in every
  branch) resume as one branch. Use `ctx.all` for the branches, or give their steps per-item names.
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
