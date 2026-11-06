---
"@spinajs/http-socket": patch
---

Idempotency and ordering use the generic stage hooks; the dispatcher, the registry and the server have no idempotency-specific code left. `IdempotencyStage` sets `ctx.drainGrace` when it claims a key, adds its claim as an outcome recorder, reads `ctx.handlerStarted` for the claim's `started`, and refuses streams through `onRegister`. `OrderingStage` refuses streams through `onRegister` and settles the command's recorders through `ctx.recordOutcome` / `ctx.detachOutcome`. Behaviour and error texts are unchanged. `ISocketIdempotencyClaim.start()` is deprecated: the claim reads `ctx.handlerStarted`.
