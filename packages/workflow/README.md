# @spinajs/workflow

Durable workflows on the application's own database. A workflow is a class whose `run(ctx)` is plain async
TypeScript; `ctx.step`, `ctx.sleep`, `ctx.waitForEvent` and `ctx.emit` are journaled, so `run` replays from the
top after every wake-up or crash and continues where it stopped. See `docs/workflow/`.

## Fan-outs

Concurrent branches (`Promise.all`) replay in the interleaving of the original run. Each step row records how many
results the workflow had received when the step was called (`Meta.after`) and when its own result arrived
(`Meta.order`); a replay hands a result back only once every call that preceded it has been made again. A step name
repeated across branches therefore keeps its occurrence and its result. This ordering matters only for concurrent
branches; sequential code replays in call order.

Per-item step names (`save:${id}` instead of `save`) are still recommended for fan-outs: they read better in the
journal and do not depend on that ordering. Code between steps may await non-durable work such as a file read or a
timer; the replay waits for the call it leads to. If such awaits in two concurrent branches finish in a different
relative order than in the original run, the replay fails with `NonDeterminismError` instead of guessing. So does a
replay where a recorded step is not asked for again, or a new step appears where the journal recorded another one.
