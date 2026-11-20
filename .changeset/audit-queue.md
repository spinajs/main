---
"@spinajs/audit": minor
---

`@spinajs/audit/queue`: `@Audited(action, { trail, fields })` on a job or event class records its publishes (`queue.publish`) and its executions (`ok`, `failed`, `denied`; on a `reject` trail an `attempt` first) through a `QueueMessageHook`. `@spinajs/queue` is an optional peer; the main entry does not load it.
