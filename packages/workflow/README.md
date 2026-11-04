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
- `Promise.race` over `ctx.sleep()` or `ctx.waitForEvent()` is not supported yet: the first operation that parks
  suspends the whole run. For a wait with a deadline use `ctx.waitForEvent(name, { timeout })`.
- Sequential code is not affected.
- A replay fails with `NonDeterminismError` when it can see the code changed: a new step where the journal recorded
  another one, or a repeated step name called at another position or after another number of results. A recorded
  step that is never asked for again fails the replay when the stall timer fires (`workflow.leaseTtl`) or at the end
  of the run.
