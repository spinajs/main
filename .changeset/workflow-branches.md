---
"@spinajs/workflow": minor
---

`ctx.all(items, fn)` and `ctx.branch(name, fn)` run a branch whose journal keys are counted on their own from its first line. A branch that awaits non-durable work before its first durable call is therefore safe, which it is not inside a plain `Promise.all`, and the code after a race over `ctx.branch` keeps its own branch. A branch writes no journal row; `ctx.all` names its branches by item index. `ctx.all(items, fn, { concurrency })` runs at most that many branches at a time and is the safe form of a bounded fan-out: a concurrency limiter around plain steps is not, unless each task is wrapped in `ctx.branch`.
