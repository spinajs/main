---
"@spinajs/authz-verify": minor
---

Verdicts say what a ceiling does to them: a holding `implies(a, b)` on a policy that compiles ceilings reports `AZV004` (info), since a ceiling whose permissions list `a` and not `b` denies `b` where `a` stays allowed; `implies(a, b, { narrowed: true })` checks that case and answers with a ceiling counterexample confirmed by the reference evaluator, or with the bounded engine's answer when every path to `a` is conditional. `never`, `onlyVia`, `separated`, `isolated` and the permission matrix are unchanged: a ceiling and `delegation: 'intersect'` only remove allows, and under `delegation: 'inherit'` a verdict speaks about the delegate. A permission that only an ABAC policy permits has no path in the exact engine yet: `implies` with it as `a`, narrowed or not, still answers `holds`.
