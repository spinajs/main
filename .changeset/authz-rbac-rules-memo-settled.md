---
"@spinajs/authz-rbac": patch
---

The request memo of the DB rule store's `forPath` reads keeps a read only once it settled. With the ORM's savepoint queue, a check inside a nested `transaction()` that awaited the read another check of the same request had started beside it, over `DbRuleStore`, never settled. A failed read is no longer kept: before, every later check of the request failed with it. Cost: 10 concurrent checks of one request on one path read the store 10 times instead of once; once a read settled, the rest of the request reads nothing.
