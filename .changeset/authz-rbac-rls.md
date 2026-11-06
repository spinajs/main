---
"@spinajs/authz-rbac": minor
---

RBAC in row level security: `RbacRlsPlanSource` plans every role whose grants give the permission on the type (its `extends` closure and ladder, the grant's scope types, tag and relation), deny roles as the exclusion; `RbacAssignmentTerm.renderSql` matches a live `authz_assignment` row held by one of `spina.subject_keys` at the row, an ancestor, the bare type or `$global`; `RbacRlsSubjectKeys` gives the session the principal's subject keys (`RbacService.subjectKeysOf`). Roles from `anonymousRoles` / `serviceRoles` and implied roles are refused (AUTHZ020, widened under `rls: 'partial'`). `RbacModel.configRoles()` is new.
