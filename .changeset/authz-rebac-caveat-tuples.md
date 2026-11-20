---
"@spinajs/authz-rebac": minor
"@spinajs/authz-ir": minor
---

Conditional tuples, storage half (Bet 6 Z5b). A tuple may carry `caveat: { name, context? }`, and a relation admits it per subject type with the OpenFGA spelling (`'user with office_ip'`, `'group#member with office_ip'`). Caveats are declared in `authz.rebac.caveats` as `{ params, expr }` over `env.*` and `principal.*` only. The caveat is not part of the tuple's identity: writing a stored tuple with another caveat throws `TupleCaveatConflict`, and to change one you remove it and add it again. The memory and DB stores keep caveats; `DbTupleStore` needs the migration `AuthzRebacCaveats_2026_11_06_00_00_00` (three nullable columns on `authz_rebac_tuple`). Changelog rows carry the caveat, and a remove now logs the stored tuple; `DbTupleStore.writeIn` returns the tuples it changed instead of counts. Until the model evaluates caveats, every reader treats a conditional tuple as not held, and `rebacToIR` refuses a schema with conditional subject types. `validateCaveats` of `@spinajs/authz-ir` checks caveat definitions on their own.
