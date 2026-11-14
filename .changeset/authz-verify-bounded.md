---
"@spinajs/authz-verify": minor
---

Bounded SMT engine for what the exact analyzer leaves `unknown`. `bounded(ir, query, { k })` searches every universe of `k` objects per type (default 3; `$global` has its one object) for data on which each check of the query gets the requested answer: one boolean per possible tuple, column relations functional, checks encoded through unions, intersections, exclusions and first-applicable priority chains with hops bounded by the evaluator's depth. Every model is re-run through the reference `IREvaluator` before it is reported as a counterexample; a model the evaluator does not confirm is blocked and the solver asked again. No model is reported as `holds` with `engine: 'bounded'` and `bound: k`. The solver is `z3-solver` ^5, an optional peer dependency loaded only when a bounded query runs; without it the verdict is `unknown` with `code: 'AZV090'`. `releaseSolver()` stops Z3's worker threads so a process can exit.
