---
"@spinajs/authz-verify": minor
---

`implies(ir, a, b)` and `onlyVia(ir, permission, holders)` decide the monotone fragment exactly. `implies` is regular-language inclusion of the tuple paths of `a` in those of `b` (a product of `a` with the lazy subset construction of `b`), so recursive `parent->` chains are covered without unrolling; `onlyVia` is emptiness once the listed holders (`role:<role>@<type>`, `role:<role>`, `<type>#<relation>`, `public`) are removed. Both return a `Verdict` (`holds | violated | unknown`, engine `exact`, the opaque parts involved); a permission with an intersection, exclusion, caveat, priority chain or opaque rewrite on its paths answers `unknown` for the bounded engine to take over. Every `violated` verdict carries a counterexample, the shortest path as its minimal tuple set, re-run through the reference `IREvaluator`; a witness the evaluator does not confirm throws `WitnessRejected`.
