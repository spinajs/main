---
"@spinajs/http": minor
---

`MiddlewareStage` gets a third value, `'beforePolicy'`: such a route middleware is mounted before the policy gate and entered first, so its `onAfter` and `onFinish` see a policy refusal (401, 403) as an error reply; the policies always run after it, so a refusal replaces an answer of its `onBefore`. Code that switches over `MiddlewareStage` exhaustively must handle the new value.
