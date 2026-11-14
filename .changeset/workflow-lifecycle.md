---
"@spinajs/workflow": minor
---

`WorkflowService` cancels (`CancelRequested`, delivered to a running activation through its lease heartbeat), retries failed instances from the step that failed the run (a step failure the workflow caught stays recorded; an instance that failed on its deadline is refused), lists instances page by page and reports unfinished instances of workflow versions no class provides (`health()`, also an engine warning once per `leaseTtl`). `WorkflowWorker` drives the engine every `workflow.tick` and stops it within `workflow.shutdownGrace`; a tick that crashes stops the loop, since the replica is then dead. `@Workflow({ timeout })` fails an instance that outlives its deadline with Reason `timeout`, aborting a step still running at that moment.
