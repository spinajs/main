---
"@spinajs/users": patch
---

When `create()` fails after inserting the account, the rows are deleted through the metadata and user models (`UserMetadataBase`, `User`) instead of bare queries. Query middlewares and write observers now see both deletes. tenancy-orm's tenant filter refuses a write without a model: with `User` registered by `registerTenantModel(User)`, a failed `create()` inside a tenant used to leave the half-created account behind. Now the delete is confined to that tenant and removes the account. The account row is still removed for good, not soft-deleted. A delete that removes no row is logged as a warning with the account's `Id` and `Uuid`.
