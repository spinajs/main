---
"@spinajs/authn-keys": major
"@spinajs/authn-local": patch
"@spinajs/authn-orm": patch
"@spinajs/authn-token": major
"@spinajs/authn-totp": patch
"@spinajs/authz-abac": patch
"@spinajs/authz-orm": patch
"@spinajs/authz-rbac": major
"@spinajs/authz-rebac": patch
"@spinajs/scheduler": patch
"@spinajs/upload": patch
---

CLI commands get the `Orm` from the services they use: the DB stores, `DbTupleStore` through `RebacModel`, `DbScopeAttributeStore`, `DefaultSchedulerService` and `UploadStore` inject it, so a command boots the ORM only when its services need a database, and `--help` works on an unmigrated database. What breaks: `AuthzCliCommand.touchesDb()` is removed (an override is never called), and the empty `KeyCliCommand` and `TokenCliCommand` bases are gone; extend `CliCommand` instead.
