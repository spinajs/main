# @spinajs/workflow

Durable workflows on the application's own database. A workflow is a class whose `run(ctx)` is plain async
TypeScript; `ctx.step`, `ctx.sleep`, `ctx.waitForEvent` and `ctx.emit` are journaled, so `run` replays from the
top after every wake-up or crash and continues where it stopped. See `docs/workflow/`.

## Fan-outs

A replay hands recorded step results back in the order the original run received them, so the branches of a
`Promise.all` continue in their original interleaving and a step repeated across branches keeps its occurrence.
Per-item step names (`save:${id}` instead of `save`) are still clearer: they read better in the journal and do not
depend on that order. Code between steps must await only durable operations; a replay that waits for a recorded
step nobody asks for fails with `NonDeterminismError`.
