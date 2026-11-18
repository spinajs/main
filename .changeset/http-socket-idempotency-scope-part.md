---
"@spinajs/http-socket": minor
---

Socket idempotency keys, of the claim and of the `after` fence, take the `IdempotencyScopePart` parts of the connection's context, on a leased and on a 3.x store. A connection without parts keeps its key.
