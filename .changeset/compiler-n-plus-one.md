---
"@spinajs/compiler": minor
---

The analyzer reports two loop patterns: `ORM101` when a relation is read inside a loop over query rows that never populated it (relations do not lazy-load, so the read sees `undefined`/`[]`), `ORM102` when a query is awaited inside a loop (N+1). They are errors in packages that set `OrmTypeRegistry.strictColumns` and warnings elsewhere; `// spinajs-orm-ignore ORM10x: <reason>` above the loop accepts a justified case. The data-flow module (`QueryTracer`, `traceQueryValues`, `iterations`, `iterationsOver`) is exported for other rules.
