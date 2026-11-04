---
"@spinajs/workflow": minor
---

`WorkflowEngine.tick()` runs due workflow instances: it claims them with a fenced row lease (several replicas drain one table without double execution), renews the lease while they run, and records the outcome. A lost lease or a crash discards the replica's late writes. A run that returns without reaching a step its journal recorded fails with `non-determinism` instead of completing. On SQLite, which runs one transaction at a time, `workflow.concurrency` is clamped to 1 with a warning.
