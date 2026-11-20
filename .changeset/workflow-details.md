---
"@spinajs/workflow": minor
---

`WorkflowService.details(id)` returns the instance with its journal rows and its pending signals, without signal payloads. `retry()` refuses an instance that is not failed, or that passed its deadline, with `WorkflowNotRetryable`, which is still an `InvalidOperation`. `WORKFLOW_STATUSES` lists every status and `isWorkflowStatus()` narrows a string to one.
