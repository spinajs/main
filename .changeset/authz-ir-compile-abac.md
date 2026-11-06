---
"@spinajs/authz-ir": minor
"@spinajs/authz-abac": minor
---

`abacToIR` / `AbacModel.toIR` compile ABAC policies into caveated permit and deny relations (a non-global `scope` and `expiresAt` become opaque terms). The merged IR now binds every permission through the `authz.combine` route of its type with exact encodings of deny-overrides, permit-overrides and first-applicable, checked against the engine's combinators on random three-valued votes. `principalNarrowing` sets the ceiling and delegation narrowing; `{ intersection: [] }` means every principal.
