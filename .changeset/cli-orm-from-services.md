---
"@spinajs/authn-keys": patch
"@spinajs/authn-local": patch
"@spinajs/authn-token": patch
"@spinajs/authn-totp": patch
"@spinajs/authz-abac": patch
"@spinajs/authz-orm": patch
"@spinajs/authz-rbac": major
"@spinajs/authz-rebac": patch
"@spinajs/scheduler": patch
"@spinajs/upload": patch
---

CLI commands get the `Orm` from the services they use: the DB stores, `DbTupleStore` through `RebacModel`, `DbScopeAttributeStore`, `DefaultSchedulerService` and `UploadStore` inject it, so a command boots the ORM only when its services need a database, and `--help` works on an unmigrated database. The internal bases `KeyCliCommand` and `TokenCliCommand` are gone; the commands extend `CliCommand`. What breaks:

- An app's own `TokenService`, `KeyStore`, `IdentityStore`, `RoleStore` or other store that queries models injects the `Orm` (`@Autoinject(Orm)`); the commands no longer resolve it for them, and `authz:check-config` no longer resolves it for an app `RoleStore`.
- `DbScopeAttributeStore` gets the `Orm` only when the DI builds it: register it by class under both `ScopeAttributeStore` and `WritableScopeAttributeStore`. One built with `new` needs the `Orm` resolved first.
- `AuthzCliCommand.touchesDb()` (`@spinajs/authz-rbac`) is removed, and the base no longer resolves the `Orm`. An override declared `protected override touchesDb()` no longer compiles: delete it. A subclass whose body queries models resolves the `Orm` itself, `await this.Container.resolve(Orm)` inside `command()`.
