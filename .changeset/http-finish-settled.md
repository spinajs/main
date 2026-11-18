---
"@spinajs/http": minor
---

`onFinish` gets `ctx.settled`, a promise that resolves once the action ended, with the error it threw, also when the client went away (`aborted`) and the action ran on. For a request whose action did not run, it resolves once the chain answered or stopped without it, with the error it answered (a refusal). It resolves once per request, the same promise for every hook, and never rejects. Code that builds an `IFinishContext` itself, such as a test calling `onFinish` directly, now passes `settled` too.
