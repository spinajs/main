---
"@spinajs/authz-orm": minor
"@spinajs/authz": patch
---

`spinajs authz:replay <decisionId> [-f text|json] [--max-changes <n>] [--fail-on divergent|unreplayable|never]` replays a logged decision with the registered `DecisionReplay` and prints the verdict, the outcome, what is missing, what diverged and the tree, or the `ReplayReport` as JSON. It exits 1 at the `--fail-on` verdict or a worse one (default `divergent`) and for an unknown id, and waits while `authz.replay.concurrency` replays run. The `DecisionReplay` doc of `@spinajs/authz` now says a replay must run outside a transaction.
