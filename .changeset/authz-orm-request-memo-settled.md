---
"@spinajs/authz-orm": patch
---

`OrmResourceAdapter.load()` and `ancestors()` share an answer within a request only once it has been read. With the ORM's savepoint queue, a check inside a nested `transaction()` that awaited the read another check of the same request had started beside it waited for a statement queued behind its own savepoint and never settled. Two calls for one ref that overlap now read it each; later calls in the request still get the kept answer.
