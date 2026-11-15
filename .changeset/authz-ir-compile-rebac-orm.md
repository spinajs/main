---
"@spinajs/authz": minor
"@spinajs/authz-ir": minor
"@spinajs/authz-rebac": minor
"@spinajs/authz-orm": minor
---

Front-end compilers into the policy IR. `AuthorizationModel.toIR?(ctx)` is the optional hook (`@spinajs/authz` stays free of `@spinajs/authz-ir`). `mergeFragments` and `compileModels` union model fragments into one `PolicyIR`, add the `$global` root type and link every root type to it, bind each permission (several models deny-overrides) and list models without `toIR` as opaque. `rebacToIR` / `RebacModel.toIR` map namespaces onto IR types; `ormToIR` turns `@Parent`, `@Owner`, `@Self` and `@Relation` columns into column-derived relations.
