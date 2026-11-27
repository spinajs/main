---
"@spinajs/authz-orm": patch
---

`DbChangeLog.lost()` no longer hands a call the marker insert of an earlier call of the same transaction while that insert is still running. With the ORM's savepoint queue, a `lost()` inside a nested `transaction()` that awaited it waited for a statement queued behind its own savepoint and never settled. A call now skips the insert only once a marker of its kind and type is written; calls that overlap write a marker each, and coverage reads the latest one.
