---
"@spinajs/authz-ir": minor
"@spinajs/authz-testing": minor
"@spinajs/cli": minor
"@spinajs/authz-rebac": patch
---

Conditional tuples across the IR tools (Bet 6 Z5b). `irToRebacConfig` keeps conditional subject types (`'user with c'`) and returns the caveats ReBAC can hold in `caveats`. `spinajs authz:import` writes them to `authz.rebac.caveats`. In `.fga.yaml` scenarios, tuple condition contexts and check contexts use the OpenFGA parameter names (`env_ip`), mapped to the IR's parameter paths through the model's conditions.

An import never keeps a subject type without its caveat: a caveat ReBAC cannot hold (a parameter outside `env.*` and `principal.*`) or one the model does not define drops every subject type that uses it, a permission that subtracts a relation which lost subject types is dropped too, and each is listed in `problems` (`authz:import --strict` refuses). The `problems` text for a wildcard subject type now reads `ReBAC holds no wildcard subject ...`. A scenario tuple that names a condition the model does not define fails the read.

`@spinajs/authz-rebac`: the type-level residual of a permission that reaches a caveat without parameters (a condition function such as `time.between`) now carries `caveatInput: {}` and is decided per row, instead of dropping those rows.

Upgrade note for code that uses the ReBAC walk types of `@spinajs/authz-rebac` directly (changed earlier in this release): `RebacWalk.targets` returns `{ object, caveat? }[]` instead of `ResourceRef[]`; `UsersetTree` has a new variant `{ kind: 'caveat', caveat, child }`, so exhaustive switches over it need a case; `SubjectList` has a required `conditional` list; the free function `listSubjects` takes an optional fifth argument, the caveat evaluator, and without it every caveat is unknown.
