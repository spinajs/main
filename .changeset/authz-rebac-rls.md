---
"@spinajs/authz-rebac": minor
---

ReBAC in row level security: `RebacRlsPlanSource` unrolls the permission's rewrite to the model's `maxDepth` tuple-to-userset hops as a `rebac.rls` term, which `RebacRlsTerm.renderSql` renders as `EXISTS` sub-queries on `authz_rebac_tuple`; `RebacRlsSubjectKeys` gives the session the principal's key and every userset holding it. Exclusions are refused, as for list plans. `rebacHolders()` is the principal-side expansion the list plan already used, now exported.
