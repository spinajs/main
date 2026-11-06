---
"@spinajs/authz-ir": minor
---

Reference evaluator `IREvaluator.check(input)`: three-valued (`allow | deny | unknown`) with ReBAC's walk semantics (memo per depth, cycles end in deny, `unknown` past `maxDepth` or `maxCalls`), wildcards, column and self relations, caveats evaluated with the engine's `DefaultConditionCompiler` (missing context is `unknown`), first-applicable priority chains, the principal ceiling and delegation (G6), and an explain tree of `{ label, truth, children, source }` nodes. `MemoryTupleSource` is an in-memory `TupleSource` for tests.
