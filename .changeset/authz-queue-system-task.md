---
"@spinajs/authz-queue": major
---

A `runAs: 'system'` job that declares no `access` and no `@SystemTask(reason)` is refused before it runs: the hook throws `JobWithoutSystemTask` (reason `system_task_missing`), a permanent failure handled like a denied `@Job({ access })`: the job is marked `dead` at once, and the amqp and stomp transports dead-letter it without a retry (SQS keeps its broker redrive; with `queue.deduplicate` on, the next delivery finds the `dead` row and is acknowledged without running). Breaking: in 3.x such a job ran as `SYSTEM`. Put `@SystemTask('<reason>')` on the job class or declare `access`; `authz.queue.systemTask: 'warn'` restores the former behaviour, one warning per job class. The default is `'deny'`.
