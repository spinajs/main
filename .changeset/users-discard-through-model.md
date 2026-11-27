---
"@spinajs/users": patch
---

When `create()` fails after inserting the account, the rows are deleted through the metadata and user models (`UserMetadataBase`, `User`) instead of bare queries. Query middlewares and write observers now see both deletes, so a middleware that refuses writes without a model (a history guard on a resource table) no longer leaves the half-created account behind. The account row is still removed for good, not soft-deleted.
