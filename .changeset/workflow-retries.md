---
"@spinajs/workflow": minor
---

A workflow step that throws a retryable error parks its instance until the backoff is over (`retry` on the step, the `@Workflow` options or `workflow.retry`); backoff jitter is derived from the instance, so replays and simulations see the same delays.
