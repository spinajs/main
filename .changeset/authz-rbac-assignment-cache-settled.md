---
"@spinajs/authz-rbac": patch
---

`AssignmentCache` keeps a subject's assignments, per request and across requests, only once the store read settled, and no read joins a load still in flight. With the ORM's savepoint queue, a check inside a nested `transaction()` that joined the load another check of the same transaction had started waited for a statement queued behind its own savepoint and never settled. Cost, measured with 10 concurrent cold checks of one principal over `DbAssignmentStore` outside a transaction: 10 store reads instead of 1, in one request and across requests alike; a settled entry still serves every later check without a read (0); when an entry's TTL runs out under load, every check running at that moment reads it again (10 instead of 1). A load that started before an invalidate still stores nothing, at either level.
