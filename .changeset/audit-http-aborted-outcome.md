---
"@spinajs/audit-http": minor
---

A request the client went away from is no longer recorded as `failed` at once. `Audit` waits for the action to end (`ctx.settled` of `@spinajs/http`) and records its outcome with `data.aborted: true`: `ok` when it succeeded after the client left, `failed` (or `denied` for a policy refusal) with the error when it threw. An action still running after `abortWaitMs` (new option, default 30000), or when the http server begins to close, is recorded as `attempt`. The wait keeps no timer that holds the process open. On a `reject` trail this is the one outcome event after the confirmed attempt.
