---
"@spinajs/scheduler": patch
---

`@spinajs/scheduler`: a tick of the scheduler loop no longer runs in the async context of the request or command that woke it (`runNow`, `retry`, `retryFailed`), nor do the later ticks its timer starts. The claim, the journal, the run hooks, a task with no tenancy hook, the `ScheduleRun*` events and the start of the run span see no request store (no tenant, principal or authz answers of the waker) and no trace parent, so a span processor that tags spans from the ambient scope no longer gives a run the waker's tenant.
