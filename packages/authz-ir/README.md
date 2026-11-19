# `@spinajs/authz-ir`

The Zanzibar-style policy IR that RBAC, ReBAC, ABAC and ORM relations compile into (Bet 6 lane Z):

- `PolicyIR` types: types with stored or column-derived relations, permission rewrites (computed, tuple-to-userset, union, intersection, exclusion, caveat, priority, opaque), caveats over the core `Condition` AST, permission bindings, combine routes, principal narrowing, and the `$global` root type.
- `canonicalize(ir)` and `policyHash(ir)`: stable JSON and its SHA-256.
- `POLICY_IR_SCHEMA`: JSON Schema (draft 2020-12) of the structure.
- `validateIR(ir)`: reference checks `IR001`-`IR005`.
- `writeOpenFga(ir)` and `readOpenFga(dsl)`: the IR as an OpenFGA 1.1 model and back. `test/fixtures/impact-3-3.ir.json` is the reference IR of the example policy of the Bet 6 impact summary (§3.3): what `rbacToIR`, `abacToIR` and the ORM scope chain emit for that config. `test/fixtures/impact-3-3.fga` is `writeOpenFga` of that file, rewritten by `UPDATE_GOLDEN=1 npm test`. They are not that section's text: tuple-to-userset is written `x from parent`, a permission with relation grants is named `rbac_<permission>`, and `can_<permission>` exists on every type of the scope chain.

`@spinajs/authz` never depends on this package.
