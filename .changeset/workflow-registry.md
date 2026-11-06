---
"@spinajs/workflow": minor
---

`@Workflow(name, { version })` registers workflow classes (also from `system.dirs.workflows`); `WorkflowService.start()` inserts an instance idempotently on its id, inside the caller's transaction when there is one.
