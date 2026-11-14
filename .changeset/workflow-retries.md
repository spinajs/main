---
"@spinajs/workflow": minor
---

A workflow step that throws a retryable error parks its instance until the backoff is over (`retry` on the step, the `@Workflow` options or `workflow.retry`); backoff jitter is derived from the instance, so replays and simulations see the same delays. Retry policies are validated before any step body runs: at registration for `@Workflow` options, when the configuration is resolved for `workflow.retry`, and at the `ctx.step` call for a step's own policy. A transactional step whose COMMIT fails after its journal row was written abandons the activation instead of spending a retry, and runs again on the next one.
