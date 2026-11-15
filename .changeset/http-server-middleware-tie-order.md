---
"@spinajs/http": patch
---

Server middlewares with equal `Order` now mount in DI registration order, as documented. They used to mount in the order their async `resolve()` finished, so a slow-resolving middleware registered first could run after one registered later.
