---
"@spinajs/authz-ir": minor
---

New package `@spinajs/authz-ir`: the Zanzibar-style policy IR that RBAC, ReBAC, ABAC and ORM relations compile into. It ships the `PolicyIR` types (stored and column-derived relations, rewrites, caveats over the core `Condition` AST, permission bindings, combine routes, principal narrowing, the `$global` root type), `canonicalize` and `policyHash` (SHA-256 of the canonical JSON) and `POLICY_IR_SCHEMA` (JSON Schema, draft 2020-12).
