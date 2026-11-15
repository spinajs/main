---
"@spinajs/http-socket": patch
---

Idempotency and ordering use the generic stage hooks; the dispatcher, the registry and the server have no idempotency-specific code left. `IdempotencyStage` sets `ctx.drainGrace` when it claims a key, adds its claim as an outcome recorder, reads `ctx.handlerStarted` for the claim's `started`, and refuses streams through `onRegister`. `OrderingStage` refuses streams through `onRegister` and settles the command's recorders through `ctx.recordOutcome` / `ctx.detachOutcome`. Behaviour and error texts are unchanged; one difference for custom stages: a custom stage above Order 550 that calls `refuseStream` now gives its own refusal wording instead of `ordered`/`idempotent` (the highest Order wins). A hand-built `ISocketCommandContext` in tests needs `addOutcomeRecorder`. `ISocketIdempotencyClaim.start()` is deprecated: the claim reads `ctx.handlerStarted`.
