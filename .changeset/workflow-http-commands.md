---
"@spinajs/workflow-http": minor
---

Routes that change a workflow instance. `POST /workflow/instances` starts one, idempotent on `id` (`workflow:manage`). `POST :id/signals/:name` signals one, signed by the caller (`workflow:signal`). `POST :id/cancel` and `POST :id/retry` cancel and retry (`workflow:manage`); a retry of an instance that is not failed answers 409. A credential restricted below its identity (a ceiling, a delegation, an impersonation, a share link) cannot sign a signal, because the wait would authorize it as the full identity; neither can a `system`, `unattended` or `anonymous` principal.
