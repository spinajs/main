---
"@spinajs/authz-rbac": minor
---

`AssignmentStore` has a new optional member, `inTransaction(): boolean`. It answers: would a read made now run inside an ORM transaction on the store's connection? `DbAssignmentStore` answers it from its driver. The assignment cache uses the answer in three ways:

- **`false`:** concurrent first checks of a subject, and the checks running when its entry expires, share one store read again. Measured over `DbAssignmentStore` with 10 concurrent cold checks outside a transaction: 1 read instead of 10, in one request and across requests; at TTL expiry, also 1 instead of 10.
- **`true`:** each check reads for itself, as before. Its rows now serve only their own request: a grant written and read inside a transaction that rolls back no longer allows later requests for up to the TTL (`authz.rbac.cache.assignmentsTtlSeconds`, 60 s by default). The same holds for a revoke: a check inside a transaction that later rolls back no longer makes later requests deny until the TTL.
- **A store that does not implement it** (a third-party store, `MemoryAssignmentStore`) keeps today's caching: no shared reads, and rows kept across requests. It also keeps the rollback window. Implementing the member closes it.
