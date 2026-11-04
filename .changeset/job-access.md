---
"@spinajs/queue": minor
"@spinajs/authz-queue": minor
"@spinajs/queue-amqp-transport": minor
"@spinajs/queue-stomp-transport": minor
---

`@Job({ access, resource })` declares the permissions a job needs: the authz-queue hook checks one of them, as the principal `runAs` chose, on `resource(message)` (default: the type-level resource of the permission) before `execute`. A denial throws `JobAccessDenied` (`access_denied`), a `PermanentJobFailure`: the consumer marks the job `dead` on its first failure and the amqp and stomp transports dead-letter it without a retry (SQS keeps its broker redrive). A job with `runAs: 'system'` and neither `access` nor `@SystemTask(reason)` logs one warning per class. An empty `access` list throws at decoration.
