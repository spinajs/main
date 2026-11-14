---
"@spinajs/idempotency": minor
---

`isCrash(error)` is exported: the crash contract of the durable fault model, an error with `crash: true` that stands for a dead process, whose claim is neither stored nor released. `@spinajs/http-socket` and the `@spinajs/http` `IdempotencyMiddleware` use it instead of their own copies.
