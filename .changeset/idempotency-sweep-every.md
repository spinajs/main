---
"@spinajs/idempotency": patch
---

`idempotency.sweepEvery` is now read, by the `idempotency.sweep` schedule of `@spinajs/idempotency-scheduler`. `@spinajs/idempotency` itself still sweeps nothing: an app without that package calls `IdempotencyService.sweep()` itself.
