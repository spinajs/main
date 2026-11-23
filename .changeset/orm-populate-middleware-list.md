---
"@spinajs/orm": minor
---

A builder has a read-only `Middlewares` getter for the result middlewares registered with `middleware()`. `BelongsToPopulateDataMiddleware` takes the relation query as its second constructor argument, where it took the relation, and reads the nested middlewares from that query instead of reaching into each nested relation. Code that constructs this middleware by hand passes the relation query. No behaviour change for a populate.
