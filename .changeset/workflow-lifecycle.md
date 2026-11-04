---
"@spinajs/workflow": minor
---

`WorkflowService` cancels (`CancelRequested`, delivered to a running activation through its lease heartbeat), retries failed instances from their failed step, lists instances page by page and reports unfinished instances of workflow versions no class provides (`health()`, also a warning on every engine tick). `WorkflowWorker` drives the engine every `workflow.tick` and stops it within `workflow.shutdownGrace`; a tick that crashes stops the loop, since the replica is then dead. `@Workflow({ timeout })` fails an instance that outlives its deadline with Reason `timeout`.
