---
"@spinajs/authz-rebac": minor
"@spinajs/authz-rbac": minor
---

ReBAC expand and listSubjects (Bet 6 Z5a). `RebacModel.expand(object, name)` returns Zanzibar's userset tree of a relation or permission: its rewrite, with the stored subjects at the leaves (subject sets listed, not followed) and `truncated` where a cycle or `maxDepth` stops it. `RebacModel.listSubjects(object, name, subjectType)` lists every subject of a type that holds it, through subject sets, arrows, union, intersection and exclusion; `complete` is false when `maxDepth` cut the walk. AuthzAdmin answers both as the `tuples.expand` and `tuples.subjects` queries (permissions `authz:tuples.expand.read` and `authz:tuples.subjects.read` at the scope); a subject list cut by `maxDepth` is a `limit_exceeded` failure. `DbAuthzAdminBackend.bumpVersion` (and the `bumpVersion` store helper) now return the new domain version, read in the batch's transaction, so `AuthzAdmin.execute(..., { consistency: true })` puts a consistency token on DB-backed results.
