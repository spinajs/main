---
"@spinajs/users": patch
---

`UserMetadataOwnerRelation` keeps the users id it read for the request only once the read has settled. With the ORM's savepoint queue, an owner check inside a nested `transaction()` that awaited the read another check of the same request had started beside it never settled. Two checks for one user that overlap now read it each.
