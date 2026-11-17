---
"@spinajs/authz": minor
"@spinajs/authz-ir": minor
---

`@spinajs/authz` gains the `DecisionReplay` port and the `ReplayReport` contract (`ReplayVerdict`, `ReplayMissing`, `ReplayDivergence`, `ReplayRead`, `ReplayTreeNode`, `ReplayOptions`); `ReplayRead` moved here from `@spinajs/authz-ir`.

`@spinajs/authz-ir` gains `replayDecision`: it re-evaluates a logged decision with the reference evaluator against the relationships at the instant the decision was logged and the policy version stored under its hash, and answers `faithful`, `divergent` or `unreplayable` through `replayVerdict`. A replay is `divergent` only on complete history: a gap read, an opaque term, a caveat over an input the record does not hold (the resource row, principal attributes and env without `captureInputs`, a captured value its tag cannot restore, an app condition function), the history budget or the timeout make it `unreplayable`, with every missing input named. With captured inputs the inputs hash is recomputed and the evidence is `inputs-hash`. A recorded `caveat_unknown` denial (`CAVEAT_UNKNOWN`) is never `divergent`.
