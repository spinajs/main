---
"@spinajs/authz-rbac": patch
---

The request memo of `MembershipStore.setsOf` keeps a read only once it settled, and only until the next `RbacModel.invalidate`. With the ORM's savepoint queue, a check inside a nested `transaction()` that awaited the read another check of the same request had started beside it, over `DbMembershipStore`, never settled. A membership read before an invalidate no longer answers the checks of the request after it (before, a request kept a revoked membership to its end). Cost: 10 concurrent checks of one request read the store 10 times instead of once; once a read settled, the rest of the request reads nothing.
