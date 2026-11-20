---
"@spinajs/orm-pglite": minor
"@spinajs/orm-postgres": patch
---

`PgliteOrmDriver` streams through a `WITH HOLD` cursor: `supportedFeatures().streaming` is now `true`, where it paged by keyset before. A query without an order streams as well, the session is free between batches so a batched `populate` works inside the loop, and the cursor is closed when the loop ends early or throws. `@spinajs/orm-postgres`: a comment only.
