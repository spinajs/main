# `@spinajs/authz-ir`

The Zanzibar-style policy IR that RBAC, ReBAC, ABAC and ORM relations compile into (Bet 6 lane Z):

- `PolicyIR` types: types with stored or column-derived relations, permission rewrites (computed, tuple-to-userset, union, intersection, exclusion, caveat, priority, opaque), caveats over the core `Condition` AST, permission bindings, combine routes, principal narrowing, and the `$global` root type.
- `canonicalize(ir)` and `policyHash(ir)`: stable JSON and its SHA-256.
- `POLICY_IR_SCHEMA`: JSON Schema (draft 2020-12) of the structure.
- `validateIR(ir)`: reference checks `IR001`-`IR005`.

`@spinajs/authz` never depends on this package.
