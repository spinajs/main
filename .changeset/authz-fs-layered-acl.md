---
"@spinajs/authz-fs": minor
---

`OrmFileAclStore` refuses with `AuthzConfigError` every call for a filesystem that an `FsProviderLayer` hands out as another provider, such as a provider listed in `tenancy.fs.prefixed` of `@spinajs/tenancy/fs`, whatever its `authz.fs` mode: the file ACL has no tenant, so one row would answer for that path in every tenant. `FsAcl` refuses before its `fs:manage` check, `AuthzFsMiddleware` and `AuthzUploadMiddleware` refuse such a filesystem in `audit` and `enforce` before any check or IO, and `FsAclRelation` (behind `fromFsPath` routes) reads no row of it. A file moved from a checked filesystem into such a provider takes no rows with it: its rows on the checked filesystem are deleted. Without a provider layer nothing changes.
